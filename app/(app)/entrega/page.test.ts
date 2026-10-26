import { beforeEach, describe, expect, it, vi } from 'vitest'

// What reaches the database, the session, Odoo or the browser is replaced: what is tested is what the page decides. The
// database is something no test here may touch (vitest.setup.ts loads the real .env when there is one).
vi.mock('@/db/client', () => ({
  db: new Proxy({}, { get: () => { throw new Error('This test must not touch the database') } }),
}))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/almacen-activo', () => ({ requireAlmacenActivo: vi.fn() }))
vi.mock('@/lib/entrega/entregas', () => ({ listarBarcosParaEntregar: vi.fn(), listarEntregadasHoy: vi.fn() }))
vi.mock('./ListaBarcos', () => ({ ListaBarcos: vi.fn() }))

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { redirect } from 'next/navigation'
import type { Almacen, Operario } from '@/db/schema'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { listarBarcosParaEntregar, listarEntregadasHoy, type BarcoParaEntregar, type EntregaDeHoy } from '@/lib/entrega/entregas'
import { ConfiguracionError, ErrorParaOperario, OdooError } from '@/lib/errores'
import { LECTURA_DE_ODOO_FALLIDA } from '@/lib/ui/lectura-fallida'
import EntregaPage from './page'
import { ListaBarcos } from './ListaBarcos'

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario
const almacen = { id: 4, prefijo: 'MB92', odooOutTypeId: 2 } as Almacen

const barcos: BarcoParaEntregar[] = [
  { barcoOdooId: 7, barcoNombre: 'MAYANQUEEN', barcoEtiqueta: 'MAYANQUEEN', paquetes: 12, desde: new Date('2026-10-14T09:00:00Z'), sinEnviar: 0 },
  { barcoOdooId: 8, barcoNombre: 'GAJA', barcoEtiqueta: 'GAJA', paquetes: 1, desde: new Date('2026-10-21T09:00:00Z'), sinEnviar: 3 },
]
const entregadas: EntregaDeHoy[] = [
  { id: 'e1', barcoNombre: 'H3', paquetes: 4, receptorNombre: 'Tom Baker', estado: 'ok' },
  { id: 'e2', barcoNombre: 'ARCTIC', paquetes: 1, receptorNombre: 'Ana', estado: 'enviando' },
  { id: 'e3', barcoNombre: 'STORMBORN', paquetes: 5, receptorNombre: 'Luis', estado: 'problema' },
]

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(operario)
  vi.mocked(requireAlmacenActivo).mockResolvedValue(almacen)
  vi.mocked(listarBarcosParaEntregar).mockResolvedValue(barcos)
  vi.mocked(listarEntregadasHoy).mockResolvedValue(entregadas)
  vi.mocked(redirect).mockImplementation((destino) => {
    throw new Error(`NEXT_REDIRECT ${destino}`)
  })
})

/** The first element of the tree that is of this type, or undefined. */
function buscar(nodo: ReactNode, tipo: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(nodo)) return nodo.map((hijo) => buscar(hijo, tipo)).find((encontrado) => encontrado !== undefined)
  if (!isValidElement<Record<string, unknown>>(nodo)) return undefined
  if (nodo.type === tipo) return nodo
  return buscar(nodo.props.children as ReactNode, tipo)
}

const dibujar = async () => renderToStaticMarkup((await EntregaPage()) as ReactElement)

describe('EntregaPage', () => {
  it('sends whoever has no valid session to the login, without reading anything', async () => {
    vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

    await expect(EntregaPage()).rejects.toThrow('NEXT_REDIRECT /login')

    expect(requireAlmacenActivo).not.toHaveBeenCalled()
    expect(listarBarcosParaEntregar).not.toHaveBeenCalled()
  })

  it('says it in a warning, and reads nothing, when the operario has no almacén', async () => {
    vi.mocked(requireAlmacenActivo).mockRejectedValue(new ErrorParaOperario('No tenés almacenes asignados. Avisá al admin.'))

    const html = await dibujar()

    expect(html).toContain('<p class="banner banner-warn">No tenés almacenes asignados. Avisá al admin.</p>')
    expect(listarBarcosParaEntregar).not.toHaveBeenCalled()
    expect(listarEntregadasHoy).not.toHaveBeenCalled()
  })

  it('does not hide what is not an answer for the operario (the database down) behind that warning', async () => {
    vi.mocked(requireAlmacenActivo).mockRejectedValue(new Error('connection refused'))

    await expect(EntregaPage()).rejects.toThrow('connection refused')
  })

  it('reads the barcos to deliver and the entregas of today in the active almacén', async () => {
    await EntregaPage()

    expect(requireAlmacenActivo).toHaveBeenCalledWith('operario-1')
    expect(listarBarcosParaEntregar).toHaveBeenCalledWith(almacen)
    expect(listarEntregadasHoy).toHaveBeenCalledWith(4)
  })

  it('draws the list of barcos with what it read, the almacén and the time it was read at', async () => {
    const antes = Date.now()
    const pagina = await EntregaPage()
    const despues = Date.now()

    const lista = buscar(pagina, ListaBarcos)
    expect(lista?.props).toMatchObject({ barcos, almacenPrefijo: 'MB92' })
    const ahora = lista?.props.ahora
    expect(ahora).toBeInstanceOf(Date)
    expect((ahora as Date).getTime()).toBeGreaterThanOrEqual(antes)
    expect((ahora as Date).getTime()).toBeLessThanOrEqual(despues)
  })

  describe('Entregadas hoy', () => {
    it('lists each entrega with its barco, its packages and who received them', async () => {
      const html = await dibujar()

      expect(html).toContain('Entregadas hoy')
      expect(html).toContain('H3')
      expect(html).toContain('4 paquetes · recibió Tom Baker')
      expect(html).toContain('1 paquete · recibió Ana')
    })

    it('says how the sync of each is going: sent, sending, or a problem that is looked at in Pendientes', async () => {
      const html = await dibujar()

      expect(html).toContain('<span class="estado-ok"><span aria-hidden="true">✓ </span>en Odoo</span>')
      expect(html).toContain('<span class="estado-enviando">enviando…</span>')
      expect(html).toMatch(/<a [^>]*class="estado-problema"[^>]*href="\/pendientes"|<a [^>]*href="\/pendientes"[^>]*class="estado-problema"/)
    })

    it('says so when there is none', async () => {
      vi.mocked(listarEntregadasHoy).mockResolvedValue([])

      expect(await dibujar()).toContain('Todavía no se entregó nada hoy.')
    })
  })

  describe('when the barcos cannot be read', () => {
    it('shows the message of a configuration error in red, with a link to read again, and no list', async () => {
      vi.mocked(listarBarcosParaEntregar).mockRejectedValue(
        new ConfiguracionError('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.'),
      )

      const pagina = await EntregaPage()
      const html = renderToStaticMarkup(pagina as ReactElement)

      expect(html).toContain('banner banner-error')
      expect(html).toContain('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')
      expect(html).toMatch(/<a [^>]*href="\/entrega"[^>]*>Reintentar<\/a>/)
      expect(buscar(pagina, ListaBarcos)).toBeUndefined()
    })

    it('says that Odoo could not be read, and not what the error says, when Odoo fails', async () => {
      vi.mocked(listarBarcosParaEntregar).mockRejectedValue(new OdooError({ status: 502, data: '<html>Bad gateway</html>' }))

      const html = await dibujar()

      expect(html).toContain(LECTURA_DE_ODOO_FALLIDA)
      expect(html).not.toContain('Bad gateway')
      expect(html).toMatch(/<a [^>]*href="\/entrega"[^>]*>Reintentar<\/a>/)
    })

    it('still shows what was delivered today: it does not come from Odoo, and the operario wants to see their entrega', async () => {
      vi.mocked(listarBarcosParaEntregar).mockRejectedValue(new TypeError('fetch failed'))

      const html = await dibujar()

      expect(html).toContain('Entregadas hoy')
      expect(html).toContain('4 paquetes · recibió Tom Baker')
    })

    it('lets through what is not a reading that failed (a bug) to the error screen', async () => {
      vi.mocked(listarBarcosParaEntregar).mockRejectedValue(new Error('Cannot read properties of undefined'))

      await expect(EntregaPage()).rejects.toThrow('Cannot read properties of undefined')
    })
  })
})
