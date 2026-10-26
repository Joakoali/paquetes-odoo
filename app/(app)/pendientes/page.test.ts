import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/sync/pendientes', () => ({ alcanceDelOperario: vi.fn(), listarProblemas: vi.fn() }))
vi.mock('./actions', () => ({ reintentarAction: vi.fn(), marcarRevisadoAction: vi.fn() }))

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { redirect } from 'next/navigation'
import type { Operario } from '@/db/schema'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { alcanceDelOperario, listarProblemas, type Problema } from '@/lib/sync/pendientes'
import { marcarRevisadoAction, reintentarAction } from './actions'
import { AccionProblema } from './AccionProblema'
import PendientesPage from './page'

/** The page reads the clock once: "hace 3 h" is counted from here. */
const AHORA = new Date('2026-10-23T12:00:00.000Z')

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(AHORA)
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(operario)
  vi.mocked(alcanceDelOperario).mockResolvedValue({ almacenIds: [1] })
  vi.mocked(listarProblemas).mockResolvedValue([])
  vi.mocked(redirect).mockImplementation((destino) => {
    throw new Error(`NEXT_REDIRECT ${destino}`)
  })
})

afterEach(() => {
  vi.useRealTimers()
})

function problema(datos: Partial<Problema> = {}): Problema {
  return {
    sesionId: 'sesion-1',
    tipo: 'error',
    sesionTipo: 'recepcion',
    almacenPrefijo: 'MB92',
    barcoNombre: 'MAYANQUEEN',
    operarioNombre: 'Veronika',
    fecha: new Date('2026-10-23T09:00:00.000Z'),
    paquetes: [],
    mensaje: 'Odoo rechazó el envío. Mirá el detalle o avisá al admin.',
    detalle: null,
    loArreglaElAdmin: false,
    ...datos,
  }
}

/** The page as the browser will be given it, as HTML. */
async function html(...problemas: Problema[]): Promise<string> {
  vi.mocked(listarProblemas).mockResolvedValue(problemas)
  return renderToStaticMarkup(await PendientesPage())
}

type Elemento = ReactElement<Record<string, unknown>>

/**
 * Every element of the tree with its function components expanded, so that the cards can be looked at as they are.
 * The buttons are not: they are client components that keep state, and what the page decides about them is the
 * element itself, with the props it gives them.
 */
function elementos(nodo: ReactNode): Elemento[] {
  if (Array.isArray(nodo)) return nodo.flatMap(elementos)
  if (!isValidElement<Record<string, unknown>>(nodo)) return []
  if (nodo.type === AccionProblema) return [nodo]
  if (typeof nodo.type === 'function') return elementos((nodo.type as (props: unknown) => ReactNode)(nodo.props))
  return [nodo, ...elementos(nodo.props.children as ReactNode)]
}

/** The buttons of the page, in order: each with its text, the action it runs, the sesión it runs it on and its look. */
async function botones(...problemas: Problema[]) {
  vi.mocked(listarProblemas).mockResolvedValue(problemas)
  return elementos(await PendientesPage())
    .filter((elemento) => elemento.type === AccionProblema)
    .map((boton) => ({
      texto: boton.props.children,
      accion: boton.props.accion,
      sesionId: boton.props.sesionId,
      className: boton.props.className,
    }))
}

/** Which of the two actions a button runs, by name, so that a failure reads better than two anonymous mocks. */
const nombreDe = (accion: unknown) =>
  accion === reintentarAction ? 'reintentarAction' : accion === marcarRevisadoAction ? 'marcarRevisadoAction' : String(accion)

describe('PendientesPage', () => {
  describe('who sees what', () => {
    it('lists the problems in the scope of the operario, read at the moment of the page', async () => {
      vi.mocked(alcanceDelOperario).mockResolvedValue({ almacenIds: [1, 3] })

      await html()

      expect(alcanceDelOperario).toHaveBeenCalledWith(operario)
      expect(listarProblemas).toHaveBeenCalledTimes(1)
      expect(listarProblemas).toHaveBeenCalledWith({ almacenIds: [1, 3] }, AHORA)
    })

    it('lists every almacén for the admin', async () => {
      vi.mocked(alcanceDelOperario).mockResolvedValue('todos')

      await html()

      expect(listarProblemas).toHaveBeenCalledWith('todos', AHORA)
    })

    it('sends whoever has no valid session to the login, without reading anything', async () => {
      vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

      await expect(PendientesPage()).rejects.toThrow('NEXT_REDIRECT /login')

      expect(listarProblemas).not.toHaveBeenCalled()
    })
  })

  it('says there is nothing pending when there are no problems, and offers nothing to press', async () => {
    const pagina = await html()

    expect(pagina).toMatch(/<h1[^>]*>Pendientes<\/h1>/)
    expect(pagina).toContain('No hay nada pendiente.')
    expect(pagina).not.toContain('<form')
    expect(pagina).not.toContain('<details')
  })

  it('does not say there is nothing pending when there is something', async () => {
    expect(await html(problema())).not.toContain('No hay nada pendiente.')
  })

  describe('a card', () => {
    it('says the type, the barco, the almacén, who and how long ago, then what happened', async () => {
      const pagina = await html(problema({
        tipo: 'error', sesionTipo: 'recepcion', barcoNombre: 'MAYANQUEEN', almacenPrefijo: 'MB92', operarioNombre: 'Veronika',
        mensaje: 'Odoo no respondió. Se reintentó solo y no hubo caso. Probá Reintentar en un rato.',
      }))

      for (const texto of [
        'No se pudo enviar a Odoo', 'Recepción', 'MAYANQUEEN', 'MB92', 'Veronika', 'hace 3 h',
        'Odoo no respondió. Se reintentó solo y no hubo caso. Probá Reintentar en un rato.',
      ]) {
        expect(pagina).toContain(texto)
      }
    })

    it.each([
      ['error', 'No se pudo enviar a Odoo'],
      ['trabado', 'Envío trabado'],
      ['duplicado', 'Paquete que no entró por duplicado'],
    ] as const)('names a %s problem "%s"', async (tipo, titulo) => {
      expect(await html(problema({ tipo }))).toContain(titulo)
    })

    it('says whether it is a recepción or an entrega', async () => {
      const pagina = await html(problema({ sesionId: 'a', sesionTipo: 'entrega' }), problema({ sesionId: 'b', sesionTipo: 'recepcion' }))

      expect(pagina).toContain('Entrega')
      expect(pagina).toContain('Recepción')
    })

    it('shows one card for each problem, in the order it is given', async () => {
      const pagina = await html(
        problema({ sesionId: 'a', barcoNombre: 'BARCO-A' }),
        problema({ sesionId: 'b', barcoNombre: 'BARCO-B' }),
        problema({ sesionId: 'c', barcoNombre: 'BARCO-C' }),
      )

      expect(pagina.match(/BARCO-[ABC]/g)).toEqual(['BARCO-A', 'BARCO-B', 'BARCO-C'])
    })

    it('lists the packages, with where Odoo already had them', async () => {
      const pagina = await html(problema({
        tipo: 'duplicado',
        paquetes: [
          { trackingNumber: 'JJD-1', ref: 'MB92/IN/00198' },
          { trackingNumber: 'JJD-2', ref: null },
        ],
      }))

      expect(pagina).toContain('JJD-1')
      expect(pagina).toContain('MB92/IN/00198')
      expect(pagina).toContain('JJD-2')
      expect(pagina.match(/MB92\/IN\//g)).toHaveLength(1)
      // Only the package that has a place in Odoo says so.
      expect(pagina.match(/ya estaba en/g)).toHaveLength(1)
    })

    it('lists the packages in the order it is given them', async () => {
      const pagina = await html(problema({
        paquetes: [
          { trackingNumber: 'JJD-9', ref: null },
          { trackingNumber: 'JJD-1', ref: null },
          { trackingNumber: 'JJD-5', ref: null },
        ],
      }))

      expect(pagina.match(/JJD-\d/g)).toEqual(['JJD-9', 'JJD-1', 'JJD-5'])
    })

    it('lists no packages for an entrega, which has none, and so does not draw an empty list', async () => {
      const sinPaquetes = await html(problema({ sesionTipo: 'entrega', paquetes: [] }))
      const conUno = await html(problema({ paquetes: [{ trackingNumber: 'JJD-1', ref: null }] }))

      // The list of cards is the only list on the first page; the second has the list of packages inside its card.
      expect(sinPaquetes.match(/<ul/g)).toHaveLength(1)
      expect(conUno.match(/<ul/g)).toHaveLength(2)
    })

    it('tells that the admin has to fix a configuration problem, and only then', async () => {
      const deConfiguracion = await html(problema({ loArreglaElAdmin: true }))
      const comun = await html(problema({ loArreglaElAdmin: false }))

      expect(deConfiguracion).toContain('Lo tiene que arreglar el admin')
      expect(comun).not.toContain('Lo tiene que arreglar el admin')
    })

    it('keeps the technical detail behind "Ver detalle", and shows it only if there is one', async () => {
      const con = await html(problema({ detalle: 'Odoo HTTP 422: El lote ya existe' }))
      const sin = await html(problema({ detalle: null }))

      expect(con).toMatch(/<details[^>]*>.*Ver detalle.*Odoo HTTP 422: El lote ya existe.*<\/details>/)
      expect(sin).not.toContain('Ver detalle')
    })

    it('does not let the text of an error act as HTML', async () => {
      const pagina = await html(problema({ detalle: '<img src=x onerror=alert(1)>', barcoNombre: '<b>H3</b>' }))

      expect(pagina).not.toContain('<img')
      expect(pagina).not.toContain('<b>H3</b>')
      expect(pagina).toContain('&lt;img src=x onerror=alert(1)&gt;')
    })
  })

  describe('the buttons', () => {
    // Spec 5.4: a failed or stuck send is solved by retrying it, and only a duplicado is "revisado". Letting an
    // operario mark a failed send as reviewed would hide it from everybody while it is still not in Odoo.
    it.each([
      ['error', ['Reintentar']],
      ['trabado', ['Reintentar']],
      ['duplicado', ['Marcar como revisado']],
    ] as const)('on a %s problem are %j', async (tipo, esperados) => {
      expect((await botones(problema({ tipo }))).map((boton) => boton.texto)).toEqual(esperados)
    })

    it('run the action of their name on the sesión of their own card', async () => {
      const todos = await botones(
        problema({ sesionId: 'sesion-a', tipo: 'error' }),
        problema({ sesionId: 'sesion-b', tipo: 'trabado' }),
        problema({ sesionId: 'sesion-c', tipo: 'duplicado' }),
      )

      expect(todos.map((boton) => [boton.texto, nombreDe(boton.accion), boton.sesionId])).toEqual([
        ['Reintentar', 'reintentarAction', 'sesion-a'],
        ['Reintentar', 'reintentarAction', 'sesion-b'],
        ['Marcar como revisado', 'marcarRevisadoAction', 'sesion-c'],
      ])
    })

    it('are handed the action itself, never a call to it: nothing runs while the page is drawn', async () => {
      await botones(problema(), problema({ sesionId: 'sesion-b' }))

      expect(reintentarAction).not.toHaveBeenCalled()
      expect(marcarRevisadoAction).not.toHaveBeenCalled()
    })

    it('are the main button for Reintentar and the secondary one for Marcar como revisado', async () => {
      const [reintentar, revisar] = await botones(problema({ sesionId: 'a', tipo: 'error' }), problema({ sesionId: 'b', tipo: 'duplicado' }))

      expect([reintentar.texto, reintentar.className]).toEqual(['Reintentar', 'btn btn-primary'])
      expect([revisar.texto, revisar.className]).toEqual(['Marcar como revisado', 'btn btn-secondary'])
    })

    it('never offer Marcar como revisado on a failed or a stuck send, wherever the problem comes from', async () => {
      const pagina = await html(
        problema({ sesionId: 'a', tipo: 'error', sesionTipo: 'recepcion' }),
        problema({ sesionId: 'b', tipo: 'error', sesionTipo: 'entrega', loArreglaElAdmin: true }),
        problema({ sesionId: 'c', tipo: 'trabado' }),
      )

      expect(pagina).not.toContain('Marcar como revisado')
      expect(pagina.match(/>Reintentar</g)).toHaveLength(3)
    })

    it('are drawn as plain buttons, enabled and with no message, until one is pressed', async () => {
      const pagina = await html(problema({ sesionId: 'a', tipo: 'error' }), problema({ sesionId: 'b', tipo: 'duplicado' }))

      expect(pagina).toMatch(/<button[^>]*type="button"[^>]*>Reintentar<\/button>/)
      expect(pagina).toMatch(/<button[^>]*class="btn btn-primary"[^>]*>Reintentar<\/button>/)
      expect(pagina).toMatch(/<button[^>]*type="button"[^>]*>Marcar como revisado<\/button>/)
      expect(pagina).toMatch(/<button[^>]*class="btn btn-secondary"[^>]*>Marcar como revisado<\/button>/)
      expect(pagina).not.toContain('disabled')
      expect(pagina).not.toContain('role="alert"')
    })

    it('are not in a form: they run the action and show its answer themselves', async () => {
      expect(await html(problema({ tipo: 'error' }), problema({ sesionId: 'sesion-b', tipo: 'duplicado' }))).not.toContain('<form')
    })
  })
})
