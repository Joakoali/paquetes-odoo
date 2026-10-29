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
import { ListaFiltrable, type ElementoFiltrable } from '@/components/lista-filtrable'
import { alcanceDelOperario, listarProblemas, type Problema } from '@/lib/sync/pendientes'
import { marcarRevisadoAction, reintentarAction } from './actions'
import { AccionProblema } from './AccionProblema'
import PendientesPage from './page'

/** The page reads the clock once: "hace 3 h" is counted from here. */
const AHORA = new Date('2026-10-23T12:00:00.000Z')

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario
const admin = { id: 'admin-1', nombre: 'Joaquín', rol: 'admin' } as Operario

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
    entrega: null,
    mensaje: 'Odoo rechazó el envío. Mirá el detalle o avisá al admin.',
    detalle: null,
    loArreglaElAdmin: false,
    ...datos,
  }
}

/** The page, with the `q` of its address if it has one. Next hands it as a promise. */
const pagina = (q?: string) => PendientesPage({ searchParams: Promise.resolve(q === undefined ? {} : { q }) })

/** The page as the browser will be given it, as HTML. */
async function html(...problemas: Problema[]): Promise<string> {
  vi.mocked(listarProblemas).mockResolvedValue(problemas)
  return renderToStaticMarkup(await pagina())
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
  // The list keeps state too (its filter): what is looked at is the cards the page hands it.
  if (nodo.type === ListaFiltrable) return (nodo.props.elementos as ElementoFiltrable[]).flatMap((elemento) => elementos(elemento.contenido))
  if (typeof nodo.type === 'function') return elementos((nodo.type as (props: unknown) => ReactNode)(nodo.props))
  return [nodo, ...elementos(nodo.props.children as ReactNode)]
}

/** The buttons of the page, in order: each with its text, the action it runs, the sesión it runs it on and its look. */
async function botones(...problemas: Problema[]) {
  vi.mocked(listarProblemas).mockResolvedValue(problemas)
  return elementos(await pagina())
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

      await expect(pagina()).rejects.toThrow('NEXT_REDIRECT /login')

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

  describe('the filter by tracking number', () => {
    const conPaquete = (sesionId: string, trackingNumber: string) =>
      problema({ sesionId, barcoNombre: `BARCO-${sesionId}`, paquetes: [{ trackingNumber, ref: null }] })

    it('is not there for a few problems, which are read at a glance', async () => {
      const html5 = await html(...['a', 'b', 'c', 'd', 'e'].map((id) => conPaquete(id, `JJD-${id}`)))

      expect(html5).not.toContain('Filtrar por tracking nº')
    })

    it('is there from six problems, with every card in view while nothing is typed', async () => {
      const html6 = await html(...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => conPaquete(id, `JJD-${id}`)))

      expect(html6).toContain('aria-label="Filtrar por tracking nº"')
      expect(html6.match(/class="card"/g)).toHaveLength(6)
    })

    it('opens with the q of the address, showing only the problems with a package that has it', async () => {
      vi.mocked(listarProblemas).mockResolvedValue([conPaquete('a', 'JJD000390007840588'), conPaquete('b', 'XW297134737JF')])

      const pantalla = renderToStaticMarkup(await pagina(' 0588 '))

      expect(pantalla).toContain('BARCO-a')
      expect(pantalla).not.toContain('BARCO-b')
      expect(pantalla).toContain('value="0588"')
      expect(pantalla).toContain('Mostrando 1 de 2')
    })

    it('says so when no problem has the package, and draws no card', async () => {
      vi.mocked(listarProblemas).mockResolvedValue([conPaquete('a', 'JJD000390007840588')])

      const pantalla = renderToStaticMarkup(await pagina('9999'))

      expect(pantalla).toContain('Ningún paquete tiene «9999» en el tracking.')
      expect(pantalla).not.toContain('class="card"')
      expect(pantalla).not.toContain('No hay nada pendiente.')
    })

    it('reads the same problems with it: the filter is drawn over them, it asks nothing more', async () => {
      await pagina('0588')

      expect(listarProblemas).toHaveBeenCalledTimes(1)
      expect(listarProblemas).toHaveBeenCalledWith({ almacenIds: [1] }, AHORA)
    })
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

    it('lists the packages an entrega handed over under how many it covers, with no place in Odoo to say', async () => {
      const pagina = await html(problema({
        sesionTipo: 'entrega',
        entrega: { paquetes: 3, receptorNombre: 'Tom Baker' },
        paquetes: [{ trackingNumber: 'JJD000390007840588', ref: null }, { trackingNumber: '1Z999AA10123456784', ref: null }],
      }))

      expect(pagina).toContain('3 paquetes · recibió Tom Baker')
      expect(pagina).toContain('JJD000390007840588')
      expect(pagina).toContain('1Z999AA10123456784')
      expect(pagina).not.toContain('ya estaba en')
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

    it('says how many packages an entrega covers and who received them, in the plain words of the entregas of today', async () => {
      const pagina = await html(problema({ sesionTipo: 'entrega', entrega: { paquetes: 3, receptorNombre: 'Capitán Pérez' } }))

      expect(pagina).toContain('3 paquetes · recibió Capitán Pérez')
    })

    it('says "1 paquete" for one, and leaves out the receiver when the entrega has none', async () => {
      const uno = await html(problema({ sesionTipo: 'entrega', entrega: { paquetes: 1, receptorNombre: null } }))

      expect(uno).toContain('1 paquete<')
      expect(uno).not.toContain('recibió')
    })

    it('says nothing of packages received for a recepción', async () => {
      const pagina = await html(problema({ sesionTipo: 'recepcion', paquetes: [{ trackingNumber: 'JJD-1', ref: null }] }))

      expect(pagina).not.toContain('recibió')
    })

    it('does not let the name of who received act as HTML', async () => {
      const pagina = await html(problema({ sesionTipo: 'entrega', entrega: { paquetes: 2, receptorNombre: '<b>Tom</b>' } }))

      expect(pagina).not.toContain('<b>Tom</b>')
      expect(pagina).toContain('&lt;b&gt;Tom&lt;/b&gt;')
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

    describe('Marcar como resuelto: for the admin, on a failed send', () => {
      // Some failures are permanent (a picking cancelled in Odoo): retrying never takes them off the list, so the
      // admin, and only the admin, can mark them as resolved. It is the same review as for a duplicado, with its own word.
      it('is offered to the admin next to Reintentar, and only on an error', async () => {
        vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)

        const todos = await botones(
          problema({ sesionId: 'sesion-a', tipo: 'error' }),
          problema({ sesionId: 'sesion-b', tipo: 'trabado' }),
          problema({ sesionId: 'sesion-c', tipo: 'duplicado' }),
        )

        expect(todos.map((boton) => [boton.texto, nombreDe(boton.accion), boton.sesionId, boton.className])).toEqual([
          ['Reintentar', 'reintentarAction', 'sesion-a', 'btn btn-primary'],
          ['Marcar como resuelto', 'marcarRevisadoAction', 'sesion-a', 'btn btn-secondary'],
          ['Reintentar', 'reintentarAction', 'sesion-b', 'btn btn-primary'],
          ['Marcar como revisado', 'marcarRevisadoAction', 'sesion-c', 'btn btn-secondary'],
        ])
      })

      it('is offered on the error of an entrega and on one that the admin has to fix', async () => {
        vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)

        const textos = (await botones(
          problema({ sesionId: 'a', tipo: 'error', sesionTipo: 'entrega' }),
          problema({ sesionId: 'b', tipo: 'error', loArreglaElAdmin: true }),
        )).map((boton) => boton.texto)

        expect(textos).toEqual(['Reintentar', 'Marcar como resuelto', 'Reintentar', 'Marcar como resuelto'])
      })

      it('is never offered to an operario, on any problem', async () => {
        const todos = await html(
          problema({ sesionId: 'a', tipo: 'error', sesionTipo: 'recepcion' }),
          problema({ sesionId: 'b', tipo: 'error', sesionTipo: 'entrega', loArreglaElAdmin: true }),
          problema({ sesionId: 'c', tipo: 'trabado' }),
          problema({ sesionId: 'd', tipo: 'duplicado' }),
        )

        expect(todos).not.toContain('Marcar como resuelto')
        expect(todos.match(/>Reintentar</g)).toHaveLength(3)
        expect(todos.match(/>Marcar como revisado</g)).toHaveLength(1)
      })

      it('is never offered on a stuck send, not even to the admin: only retrying takes it out', async () => {
        vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)

        expect((await botones(problema({ tipo: 'trabado' }))).map((boton) => boton.texto)).toEqual(['Reintentar'])
      })
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
