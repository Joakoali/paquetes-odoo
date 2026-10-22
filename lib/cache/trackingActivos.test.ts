import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('@/lib/odoo/client', () => ({ odooCall: vi.fn() }))

import { asc, count } from 'drizzle-orm'
import { db } from '@/db/client'
import { trackingActivosCache } from '@/db/schema'
import { odooCall } from '@/lib/odoo/client'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { buscarDuplicado, PAGINA_TRACKINGS, recordSyncedTrackings, refreshTrackingActivos } from './trackingActivos'

const ANTES = new Date('2026-01-01T00:00:00.000Z')

/** A move line as Odoo's `search_read` answers it. */
function lineaOdoo(tracking: string, picking: string, tipo: 'incoming' | 'outgoing' = 'incoming', pickingId = 100) {
  return { lot_id: [1, tracking], picking_id: [pickingId, picking], picking_code: tipo }
}

/** `n` lines of the same reception, with the trackings `${prefijo}0` to `${prefijo}${n - 1}`. */
function lineas(prefijo: string, n: number) {
  return Array.from({ length: n }, (_, i) => lineaOdoo(`${prefijo}${i}`, 'MB92/IN/00001', 'incoming', 1))
}

/** What Odoo answers to each successive page request; any request after those gets an empty page. */
function odooResponde(...paginas: unknown[][]) {
  vi.mocked(odooCall).mockResolvedValue([])
  for (const pagina of paginas) vi.mocked(odooCall).mockResolvedValueOnce(pagina)
}

/** The `offset` and `limit` of every request made to Odoo, in order. */
function paginasPedidas() {
  return vi.mocked(odooCall).mock.calls.map(([, , params]) => {
    const { offset, limit } = params as { offset: number; limit: number }
    return { offset, limit }
  })
}

const cache = () => db.select().from(trackingActivosCache).orderBy(asc(trackingActivosCache.trackingNumber))
const segundosDesde = (fecha: Date) => Math.abs(Date.now() - fecha.getTime()) / 1000

beforeEach(async () => {
  vi.resetAllMocks()
  odooResponde()
  await resetTestDb(db as unknown as TestDb)
})

describe('buscarDuplicado', () => {
  it('returns null for a tracking the cache does not know', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'ABC', odooPickingId: 501, odooPickingRef: 'MB92/IN/00198' })

    expect(await buscarDuplicado('XYZ')).toBeNull()
  })

  it('buscarDuplicado returns the Odoo reference of a known tracking', async () => {
    await db.insert(trackingActivosCache).values([
      { trackingNumber: 'ABC', odooPickingId: 501, odooPickingRef: 'MB92/IN/00198' },
      { trackingNumber: 'XYZ', odooPickingId: 502, odooPickingRef: 'MB92/IN/00199' },
    ])

    expect(await buscarDuplicado('ABC')).toEqual({ odooPickingRef: 'MB92/IN/00198' })
    expect(await buscarDuplicado('XYZ')).toEqual({ odooPickingRef: 'MB92/IN/00199' })
  })

  it('falls back to the picking id when the row has no reference', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'ABC', odooPickingId: 501 })

    expect(await buscarDuplicado('ABC')).toEqual({ odooPickingRef: 'picking #501' })
  })

  it('matches the whole tracking number, exactly', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'ABCD', odooPickingId: 501, odooPickingRef: 'MB92/IN/00198' })

    expect(await buscarDuplicado('ABC')).toBeNull()
    expect(await buscarDuplicado('abcd')).toBeNull()
    expect(await buscarDuplicado('ABCD')).not.toBeNull()
  })
})

describe('recordSyncedTrackings', () => {
  it('upserts every row in one call, with its reference', async () => {
    await recordSyncedTrackings([
      { trackingNumber: 'ABC', odooPickingId: 501, odooPickingRef: 'MB92/IN/00198' },
      { trackingNumber: 'XYZ', odooPickingId: 501, odooPickingRef: 'MB92/IN/00198' },
    ])

    const filas = await cache()
    expect(filas).toMatchObject([
      { trackingNumber: 'ABC', odooPickingId: 501, odooPickingRef: 'MB92/IN/00198' },
      { trackingNumber: 'XYZ', odooPickingId: 501, odooPickingRef: 'MB92/IN/00198' },
    ])
    filas.forEach((fila) => expect(segundosDesde(fila.updatedAt)).toBeLessThan(5))
  })

  it('is a no-op for an empty list', async () => {
    await recordSyncedTrackings([])

    expect(await cache()).toEqual([])
  })

  it('stores a row without a reference, as the sync worker still sends them', async () => {
    await recordSyncedTrackings([{ trackingNumber: 'ABC', odooPickingId: 501 }])

    expect(await cache()).toMatchObject([{ trackingNumber: 'ABC', odooPickingId: 501, odooPickingRef: null }])
  })

  it('moves a tracking that is already cached to its new picking and renews its updatedAt', async () => {
    await db.insert(trackingActivosCache).values({
      trackingNumber: 'ABC', odooPickingId: 1, odooPickingRef: 'MB92/IN/00001', updatedAt: ANTES,
    })

    await recordSyncedTrackings([
      { trackingNumber: 'ABC', odooPickingId: 2, odooPickingRef: 'MB92/IN/00002' },
      { trackingNumber: 'XYZ', odooPickingId: 2, odooPickingRef: 'MB92/IN/00002' },
    ])

    const [abc, xyz] = await cache()
    expect(abc).toMatchObject({ trackingNumber: 'ABC', odooPickingId: 2, odooPickingRef: 'MB92/IN/00002' })
    expect(xyz).toMatchObject({ trackingNumber: 'XYZ', odooPickingId: 2, odooPickingRef: 'MB92/IN/00002' })
    expect(segundosDesde(abc.updatedAt)).toBeLessThan(5)
  })

  it('never keeps the reference of the picking a tracking was in before', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'ABC', odooPickingId: 1, odooPickingRef: 'MB92/IN/00001' })

    await recordSyncedTrackings([{ trackingNumber: 'ABC', odooPickingId: 2 }])

    expect(await buscarDuplicado('ABC')).toEqual({ odooPickingRef: 'picking #2' })
  })
})

describe('refreshTrackingActivos', () => {
  it('refreshTrackingActivos pages through Odoo until a short page', async () => {
    odooResponde(lineas('A', PAGINA_TRACKINGS), lineas('B', 3))

    const resultado = await refreshTrackingActivos()

    expect(PAGINA_TRACKINGS).toBe(2000)
    expect(odooCall).toHaveBeenCalledTimes(2)
    expect(paginasPedidas()).toEqual([{ offset: 0, limit: 2000 }, { offset: 2000, limit: 2000 }])
    expect(resultado).toEqual({ filas: 2003 })
    expect((await db.select({ n: count() }).from(trackingActivosCache))[0].n).toBe(2003)
  })

  it('stops at the first page when it is short', async () => {
    odooResponde(lineas('A', 3), lineas('B', 3)) // the second page must never be asked for

    await refreshTrackingActivos()

    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(await cache()).toHaveLength(3)
  })

  it('asks for the next page when a page comes back exactly full', async () => {
    odooResponde(lineas('A', PAGINA_TRACKINGS), [])

    const resultado = await refreshTrackingActivos()

    expect(paginasPedidas()).toEqual([{ offset: 0, limit: 2000 }, { offset: 2000, limit: 2000 }])
    expect(resultado).toEqual({ filas: 2000 })
  })

  it('prefers the reception reference when a tracking is in a reception and a delivery', async () => {
    odooResponde([
      lineaOdoo('JJD1', 'MB92/IN/00198', 'incoming', 9), // the reception comes first, as it usually does
      lineaOdoo('JJD1', 'MB92/OUT/00045', 'outgoing', 12),
      lineaOdoo('XW2', 'MB92/OUT/00046', 'outgoing', 13), // here the delivery comes first
      lineaOdoo('XW2', 'MB92/IN/00199', 'incoming', 10),
      lineaOdoo('UPS3', 'MB92/OUT/00047', 'outgoing', 14), // only delivered: its delivery is all there is
    ])

    await refreshTrackingActivos()

    expect(await cache()).toMatchObject([
      { trackingNumber: 'JJD1', odooPickingId: 9, odooPickingRef: 'MB92/IN/00198' },
      { trackingNumber: 'UPS3', odooPickingId: 14, odooPickingRef: 'MB92/OUT/00047' },
      { trackingNumber: 'XW2', odooPickingId: 10, odooPickingRef: 'MB92/IN/00199' },
    ])
  })

  it('compares a tracking across pages: the reception on the first one wins over the delivery on the second', async () => {
    odooResponde(
      [lineaOdoo('JJD1', 'MB92/IN/00198', 'incoming', 9), ...lineas('A', PAGINA_TRACKINGS - 1)],
      [lineaOdoo('JJD1', 'MB92/OUT/00045', 'outgoing', 12)],
    )

    await refreshTrackingActivos()

    expect(await buscarDuplicado('JJD1')).toEqual({ odooPickingRef: 'MB92/IN/00198' })
  })

  it('keeps the first reception when a tracking is in two of them', async () => {
    odooResponde([
      lineaOdoo('JJD1', 'MB92/IN/00198', 'incoming', 9),
      lineaOdoo('JJD1', 'MB92/IN/00250', 'incoming', 15),
    ])

    await refreshTrackingActivos()

    expect(await buscarDuplicado('JJD1')).toEqual({ odooPickingRef: 'MB92/IN/00198' })
  })

  it('counts each tracking once, however many lines it has', async () => {
    odooResponde([
      lineaOdoo('JJD1', 'MB92/IN/00198', 'incoming', 9),
      lineaOdoo('JJD1', 'MB92/OUT/00045', 'outgoing', 12),
      lineaOdoo('XW2', 'MB92/IN/00199', 'incoming', 10),
    ])

    expect(await refreshTrackingActivos()).toEqual({ filas: 2 })
  })

  it('removes trackings that are no longer in Odoo', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'VIEJO', odooPickingId: 1, updatedAt: new Date('2026-01-01') })
    odooResponde([lineaOdoo('VIGENTE', 'MB92/IN/00198', 'incoming', 9)])

    await refreshTrackingActivos()

    expect(await buscarDuplicado('VIEJO')).toBeNull()
    expect(await buscarDuplicado('VIGENTE')).toEqual({ odooPickingRef: 'MB92/IN/00198' })
  })

  it('leaves the cache untouched when Odoo returns no lines at all', async () => {
    await db.insert(trackingActivosCache).values({
      trackingNumber: 'VIEJO', odooPickingId: 1, odooPickingRef: 'MB92/IN/00001', updatedAt: ANTES,
    })
    odooResponde([]) // an empty first page: more likely a failed or filtered read than "Odoo has none"

    const resultado = await refreshTrackingActivos()

    expect(resultado).toEqual({ filas: 0 })
    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(await cache()).toMatchObject([
      { trackingNumber: 'VIEJO', odooPickingId: 1, odooPickingRef: 'MB92/IN/00001', updatedAt: ANTES },
    ])
  })

  it('still removes what Odoo no longer has when only the last page is empty', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'VIEJO', odooPickingId: 1, updatedAt: ANTES })
    odooResponde(lineas('A', PAGINA_TRACKINGS), [])

    await refreshTrackingActivos()

    expect(await buscarDuplicado('VIEJO')).toBeNull()
    expect(await buscarDuplicado('A0')).not.toBeNull()
  })

  it('updates the picking and the reference of a tracking that Odoo has moved', async () => {
    await db.insert(trackingActivosCache).values({
      trackingNumber: 'JJD1', odooPickingId: 1, odooPickingRef: 'MB92/IN/00001', updatedAt: ANTES,
    })
    odooResponde([lineaOdoo('JJD1', 'MB92/IN/00198', 'incoming', 9)])

    await refreshTrackingActivos()

    expect(await cache()).toMatchObject([{ trackingNumber: 'JJD1', odooPickingId: 9, odooPickingRef: 'MB92/IN/00198' }])
  })

  it('fills in the reference of a row the sync wrote without one', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'JJD1', odooPickingId: 9, updatedAt: ANTES })
    odooResponde([lineaOdoo('JJD1', 'MB92/IN/00198', 'incoming', 9)])

    await refreshTrackingActivos()

    expect(await buscarDuplicado('JJD1')).toEqual({ odooPickingRef: 'MB92/IN/00198' })
  })

  it('keeps a row written by a sync while the refresh was running', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'VIEJO', odooPickingId: 1, updatedAt: ANTES })
    vi.mocked(odooCall).mockImplementationOnce(async () => {
      // A reception is synced while the refresh waits for Odoo: the page Odoo is about to
      // send was read before that picking existed, so it does not have the tracking.
      await recordSyncedTrackings([{ trackingNumber: 'RECIEN', odooPickingId: 77, odooPickingRef: 'MB92/IN/00300' }])
      await new Promise((resolve) => setTimeout(resolve, 20))
      return [lineaOdoo('DE-ODOO', 'MB92/IN/00005', 'incoming', 5)]
    })

    await refreshTrackingActivos()

    expect(await buscarDuplicado('RECIEN')).toEqual({ odooPickingRef: 'MB92/IN/00300' })
    expect(await buscarDuplicado('DE-ODOO')).not.toBeNull()
    expect(await buscarDuplicado('VIEJO')).toBeNull()
  })

  it('leaves the cache as it was when Odoo fails halfway', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'VIEJO', odooPickingId: 1, updatedAt: ANTES })
    vi.mocked(odooCall)
      .mockResolvedValueOnce(lineas('A', PAGINA_TRACKINGS))
      .mockRejectedValueOnce(new Error('Odoo no respondió'))

    await expect(refreshTrackingActivos()).rejects.toThrow('Odoo no respondió')

    expect(await cache()).toMatchObject([{ trackingNumber: 'VIEJO', odooPickingId: 1 }])
  })

  it.each([
    [1000, 1],
    [1001, 2],
    [2000, 2],
  ])('writes %i trackings in %i statement(s) of at most 1000 rows', async (trackings, inserts) => {
    odooResponde(lineas('A', trackings))
    const insert = vi.spyOn(db, 'insert')
    try {
      await refreshTrackingActivos()
      expect(insert).toHaveBeenCalledTimes(inserts)
    } finally {
      insert.mockRestore()
    }
    expect((await db.select({ n: count() }).from(trackingActivosCache))[0].n).toBe(trackings)
  })
})
