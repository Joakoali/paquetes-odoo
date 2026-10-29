import { beforeEach, describe, expect, it, vi } from 'vitest'

// What reaches the session, Odoo or the browser is replaced: what is tested is what the page decides. The barco is read
// from the cache table, which is the real thing here: an in-memory database.
vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/almacen-activo', () => ({ requireAlmacenActivo: vi.fn() }))
vi.mock('@/lib/odoo/pickings', () => ({ getLineasEntregaPendiente: vi.fn() }))
vi.mock('@/lib/recepcion/recepciones', () => ({ contarSinEnviarPorBarco: vi.fn() }))
vi.mock('./EntregaFlow', () => ({ EntregaFlow: vi.fn() }))

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { notFound, redirect } from 'next/navigation'
import { db } from '@/db/client'
import { sesionesEscaneo, type Almacen, type Operario } from '@/db/schema'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { ConfiguracionError, ErrorParaOperario, OdooError } from '@/lib/errores'
import { getLineasEntregaPendiente, type LineaEntrega } from '@/lib/odoo/pickings'
import { contarSinEnviarPorBarco } from '@/lib/recepcion/recepciones'
import { seedAlmacen, seedBarco, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { LECTURA_DE_ODOO_FALLIDA } from '@/lib/ui/lectura-fallida'
import EntregaBarcoPage from './page'
import { EntregaFlow } from './EntregaFlow'

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario
const almacen = { id: 4, prefijo: 'MB92', odooOutTypeId: 2 } as Almacen

const linea = (moveLineId: number, datos: Partial<LineaEntrega> = {}): LineaEntrega => ({
  moveLineId, pickingId: 700, pickingRef: 'MB92/OUT/00487', trackingNumber: `T${moveLineId}`, courierNombre: 'DHL', ...datos,
})
const lineas = [linea(11), linea(12), linea(13, { trackingNumber: null, courierNombre: 'UPS (incorrecto)' })]

/** An entrega of the almacén for the barco, written straight to the database so that it can be in any estado, almacén or barco. */
async function entregaCon(
  operarioId: string,
  lineasIds: number[],
  estado: typeof sesionesEscaneo.$inferInsert['estado'],
  datos: Partial<typeof sesionesEscaneo.$inferInsert> = {},
) {
  await db.insert(sesionesEscaneo).values({
    operarioId,
    almacenId: almacen.id,
    barcoOdooId: 673,
    tipo: 'entrega',
    estado,
    odooPickingIds: [700],
    odooMoveLineIds: lineasIds,
    receptorNombre: 'Capitán Pérez',
    firmaData: 'AAA',
    confirmedAt: new Date(),
    ...datos,
  })
}

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  // The almacén the operario works in is in the database too: the entregas that hold lines belong to it.
  await seedAlmacen(db, { id: almacen.id })
  await seedBarco(db, { odooId: 673, nombre: 'MAYANQUEEN' })
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(operario)
  vi.mocked(requireAlmacenActivo).mockResolvedValue(almacen)
  vi.mocked(getLineasEntregaPendiente).mockResolvedValue(lineas)
  vi.mocked(contarSinEnviarPorBarco).mockResolvedValue(new Map())
  vi.mocked(notFound).mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND')
  })
  vi.mocked(redirect).mockImplementation((destino) => {
    throw new Error(`NEXT_REDIRECT ${destino}`)
  })
})

/** The page for the id that is in the address bar, and its `q` if it has one. Next hands both as promises. */
const pagina = (barcoOdooId = '673', q?: string | string[]) => EntregaBarcoPage({
  params: Promise.resolve({ barcoOdooId }),
  searchParams: Promise.resolve(q === undefined ? {} : { q }),
})

/** The first element of the tree that is of this type, or undefined. */
function buscar(nodo: ReactNode, tipo: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(nodo)) return nodo.map((hijo) => buscar(hijo, tipo)).find((encontrado) => encontrado !== undefined)
  if (!isValidElement<Record<string, unknown>>(nodo)) return undefined
  if (nodo.type === tipo) return nodo
  return buscar(nodo.props.children as ReactNode, tipo)
}

describe('EntregaBarcoPage', () => {
  it('sends whoever has no valid session to the login, without reading anything', async () => {
    vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

    await expect(pagina()).rejects.toThrow('NEXT_REDIRECT /login')

    expect(requireAlmacenActivo).not.toHaveBeenCalled()
    expect(getLineasEntregaPendiente).not.toHaveBeenCalled()
  })

  it('says it in a warning, and reads nothing from Odoo, when the operario has no almacén', async () => {
    vi.mocked(requireAlmacenActivo).mockRejectedValue(new ErrorParaOperario('No tenés almacenes asignados. Avisá al admin.'))

    const html = renderToStaticMarkup((await pagina()) as ReactElement)

    expect(html).toContain('<p class="banner banner-warn">No tenés almacenes asignados. Avisá al admin.</p>')
    expect(getLineasEntregaPendiente).not.toHaveBeenCalled()
  })

  it('does not hide what is not an answer for the operario (the database down) behind that warning', async () => {
    vi.mocked(requireAlmacenActivo).mockRejectedValue(new Error('connection refused'))

    await expect(pagina()).rejects.toThrow('connection refused')
  })

  describe('the id in the address', () => {
    it.each(['abc', '67x', '', '0', '-5', '1.5', '1e3', '99999999999', ' 673'])('is not a barco when it says "%s": nothing is read', async (texto) => {
      await expect(pagina(texto)).rejects.toThrow('NEXT_NOT_FOUND')

      expect(getLineasEntregaPendiente).not.toHaveBeenCalled()
    })

    it('is not found when Odoo has no lines for the barco and the cache does not know it either', async () => {
      vi.mocked(getLineasEntregaPendiente).mockResolvedValue([])

      await expect(pagina('999')).rejects.toThrow('NEXT_NOT_FOUND')

      // The cache is not what says whether there is a barco: Odoo is asked first.
      expect(getLineasEntregaPendiente).toHaveBeenCalledWith({ outTypeId: 2, barcoOdooId: 999 })
    })

    it('opens a barco that is not in the cache when Odoo has lines waiting for it, named by its id like the list of barcos does', async () => {
      // Created in Odoo after the last refresh of the cache, or archived since: the list of barcos shows it all the same.
      const flujo = buscar(await pagina('999'), EntregaFlow)

      expect(flujo?.props).toMatchObject({ barcoOdooId: 999, barcoNombre: 'Barco #999', lineas })
    })

    it('opens a barco that is not in the cache when all the lines Odoo has for it are held: they are there, and on their way', async () => {
      const { id: veronikaId } = await seedOperario(db, { nombre: 'Veronika' })
      await entregaCon(veronikaId, [11, 12, 13], 'confirmada_pendiente_sync', { barcoOdooId: 999 })

      const flujo = buscar(await pagina('999'), EntregaFlow)

      expect(flujo?.props).toMatchObject({ barcoNombre: 'Barco #999', lineas: [], enviandose: 3 })
    })

    it('opens a barco that is not in the cache and has no lines in Odoo but has packages received and not sent: the list of barcos shows it', async () => {
      vi.mocked(getLineasEntregaPendiente).mockResolvedValue([])
      vi.mocked(contarSinEnviarPorBarco).mockResolvedValue(new Map([[999, 2]]))

      const flujo = buscar(await pagina('999'), EntregaFlow)

      expect(flujo?.props).toMatchObject({ barcoNombre: 'Barco #999', lineas: [], sinEnviar: 2 })
    })

    it('prefers the name of the cache to the placeholder', async () => {
      const flujo = buscar(await pagina('673'), EntregaFlow)

      expect(flujo?.props.barcoNombre).toBe('MAYANQUEEN')
    })

    it('opens a barco of the cache that Odoo has nothing waiting for: it says so, and is not a page that does not exist', async () => {
      vi.mocked(getLineasEntregaPendiente).mockResolvedValue([])

      const flujo = buscar(await pagina('673'), EntregaFlow)

      expect(flujo?.props).toMatchObject({ barcoNombre: 'MAYANQUEEN', lineas: [] })
    })

    it('says that Odoo could not be read, under the placeholder name, for a barco the cache does not know: nothing says it does not exist', async () => {
      vi.mocked(getLineasEntregaPendiente).mockRejectedValue(new OdooError({ status: 502, data: '<html>Bad gateway</html>' }))

      const html = renderToStaticMarkup((await pagina('999')) as ReactElement)

      expect(html).toContain('Barco #999')
      expect(html).toContain(LECTURA_DE_ODOO_FALLIDA)
    })

    it('opens a barco that is no longer active in the cache: it may still have deliveries waiting', async () => {
      await seedBarco(db, { odooId: 674, nombre: 'ANTIGUO', activo: false })

      const flujo = buscar(await pagina('674'), EntregaFlow)

      expect(flujo?.props).toMatchObject({ barcoOdooId: 674, barcoNombre: 'ANTIGUO' })
    })
  })

  it('reads the lines of the barco in the delivery type of the active almacén, and what is received and not sent', async () => {
    vi.mocked(contarSinEnviarPorBarco).mockResolvedValue(new Map([[673, 3], [999, 8]]))

    await pagina()

    expect(getLineasEntregaPendiente).toHaveBeenCalledWith({ outTypeId: 2, barcoOdooId: 673 })
    expect(contarSinEnviarPorBarco).toHaveBeenCalledWith(4)
  })

  it('draws the flow with the name from the cache, the almacén, the lines and the packages not sent of this barco', async () => {
    vi.mocked(contarSinEnviarPorBarco).mockResolvedValue(new Map([[673, 3], [999, 8]]))

    const flujo = buscar(await pagina(), EntregaFlow)

    expect(flujo?.props).toEqual({
      barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', almacenPrefijo: 'MB92', lineas, sinEnviar: 3, enviandose: 0, filtroInicial: '',
    })
  })

  describe('the q of the address', () => {
    it('is what the list of packages opens filtered by: the search of a package leads here with it', async () => {
      const flujo = buscar(await pagina('673', ' 0588 '), EntregaFlow)

      expect(flujo?.props.filtroInicial).toBe('0588')
    })

    it('is the first one when the address has it twice', async () => {
      const flujo = buscar(await pagina('673', ['0588', '1234']), EntregaFlow)

      expect(flujo?.props.filtroInicial).toBe('0588')
    })

    it('reads Odoo the same with it: the filter is drawn over the lines, it asks nothing of Odoo', async () => {
      await pagina('673', '0588')

      expect(getLineasEntregaPendiente).toHaveBeenCalledTimes(1)
      expect(getLineasEntregaPendiente).toHaveBeenCalledWith({ outTypeId: 2, barcoOdooId: 673 })
    })
  })

  describe('packages that an entrega on its way to Odoo already holds', () => {
    it('leaves them out of what is offered, and says how many there are: a second entrega of them must not be one tap away', async () => {
      const { id: veronikaId } = await seedOperario(db, { nombre: 'Veronika' })
      // Confirmed a moment ago: the worker has not got to it, so Odoo still lists its packages as pending.
      await entregaCon(veronikaId, [11, 12], 'confirmada_pendiente_sync')

      const flujo = buscar(await pagina(), EntregaFlow)

      expect(flujo?.props.lineas).toEqual([linea(13, { trackingNumber: null, courierNombre: 'UPS (incorrecto)' })])
      expect(flujo?.props.enviandose).toBe(2)
    })

    it('still draws the flow when every package is held, with nothing to offer and all of them on their way', async () => {
      const { id: veronikaId } = await seedOperario(db, { nombre: 'Veronika' })
      await entregaCon(veronikaId, [11, 12, 13], 'confirmada_pendiente_sync')

      const flujo = buscar(await pagina(), EntregaFlow)

      expect(flujo?.props).toMatchObject({ lineas: [], enviandose: 3 })
    })

    it('offers them again once the entrega is not waiting for its sync: it is in Odoo, or it failed and nothing was delivered', async () => {
      const { id: veronikaId } = await seedOperario(db, { nombre: 'Veronika' })
      await entregaCon(veronikaId, [11], 'sincronizada')
      await entregaCon(veronikaId, [12], 'error')

      const flujo = buscar(await pagina(), EntregaFlow)

      expect(flujo?.props.lineas).toEqual(lineas)
      expect(flujo?.props.enviandose).toBe(0)
    })

    it('holds only what the entregas of this almacén and this barco hold', async () => {
      const { id: veronikaId } = await seedOperario(db, { nombre: 'Veronika' })
      const tgn = await seedAlmacen(db, { prefijo: 'TGN', nombre: 'Port Tarraco (TGN)', odooWarehouseId: 5, odooInTypeId: 21, odooOutTypeId: 22 })
      await seedBarco(db, { odooId: 674, nombre: 'MAYANQUEENIV' })
      await entregaCon(veronikaId, [11], 'confirmada_pendiente_sync', { almacenId: tgn.id })
      await entregaCon(veronikaId, [12], 'confirmada_pendiente_sync', { barcoOdooId: 674 })

      const flujo = buscar(await pagina(), EntregaFlow)

      expect(flujo?.props.lineas).toEqual(lineas)
      expect(flujo?.props.enviandose).toBe(0)
    })
  })

  it('draws it in a screen that is as tall as the viewport, so that the box to sign in takes the height that is left', async () => {
    const resultado = (await pagina()) as ReactElement<{ className: string }>

    expect(resultado.type).toBe('main')
    expect(resultado.props.className).toBe('page entrega-pagina')
  })

  it('says 0 packages unsent when this barco has none, whatever others have', async () => {
    vi.mocked(contarSinEnviarPorBarco).mockResolvedValue(new Map([[999, 8]]))

    const flujo = buscar(await pagina(), EntregaFlow)

    expect(flujo?.props.sinEnviar).toBe(0)
  })

  it('starts the flow again when the lines it was given change, so that the choice is of the lines that are there', async () => {
    const antes = buscar(await pagina(), EntregaFlow)
    vi.mocked(getLineasEntregaPendiente).mockResolvedValue([...lineas, linea(14)])
    const despues = buscar(await pagina(), EntregaFlow)
    vi.mocked(getLineasEntregaPendiente).mockResolvedValue(lineas)
    const igual = buscar(await pagina(), EntregaFlow)

    expect(despues?.key).not.toBe(antes?.key)
    expect(igual?.key).toBe(antes?.key)
  })

  describe('when Odoo cannot be read', () => {
    it('shows the message of a configuration error in red, with a link to read again and one to go back', async () => {
      vi.mocked(getLineasEntregaPendiente).mockRejectedValue(
        new ConfiguracionError('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.'),
      )

      const resultado = await pagina()
      const html = renderToStaticMarkup(resultado as ReactElement)

      expect(html).toContain('banner banner-error')
      expect(html).toContain('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')
      expect(html).toMatch(/<a [^>]*href="\/entrega\/673"[^>]*>Reintentar<\/a>/)
      expect(html).toMatch(/<a [^>]*href="\/entrega"[^>]*>‹ Entrega<\/a>/)
      expect(buscar(resultado, EntregaFlow)).toBeUndefined()
    })

    it('does not read Odoo when the almacén has no delivery type: it says what to do', async () => {
      vi.mocked(requireAlmacenActivo).mockResolvedValue({ ...almacen, odooOutTypeId: null })

      const html = renderToStaticMarkup((await pagina()) as ReactElement)

      expect(html).toContain('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')
      expect(getLineasEntregaPendiente).not.toHaveBeenCalled()
    })

    it('says that Odoo could not be read, and not what the error says, when Odoo fails', async () => {
      vi.mocked(getLineasEntregaPendiente).mockRejectedValue(new OdooError({ status: 502, data: '<html>Bad gateway</html>' }))

      const html = renderToStaticMarkup((await pagina()) as ReactElement)

      expect(html).toContain(LECTURA_DE_ODOO_FALLIDA)
      expect(html).not.toContain('Bad gateway')
    })

    it('lets through what is not a reading that failed (a bug) to the error screen', async () => {
      vi.mocked(getLineasEntregaPendiente).mockRejectedValue(new Error('Cannot read properties of undefined'))

      await expect(pagina()).rejects.toThrow('Cannot read properties of undefined')
    })
  })
})
