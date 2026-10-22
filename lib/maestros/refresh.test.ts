import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('@/lib/odoo/maestros', () => ({
  fetchAlmacenes: vi.fn(),
  fetchCouriers: vi.fn(),
  fetchBarcos: vi.fn(),
  fetchUsoCouriers: vi.fn(),
}))

import { asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { almacenes, barcosCache, courierUso, couriers, operarioAlmacenes } from '@/db/schema'
import {
  fetchAlmacenes, fetchBarcos, fetchCouriers, fetchUsoCouriers,
  type AlmacenOdoo, type BarcoOdoo, type CourierOdoo, type UsoCourierOdoo,
} from '@/lib/odoo/maestros'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { seedAlmacen, seedBarco, seedCourier, seedOperario } from '@/lib/testing/seed'
import { DIAS_USO_COURIERS, refreshMaestros, ultimoRefresco } from './refresh'

const MB92: AlmacenOdoo = { warehouseId: 1, codigo: 'MB92', nombre: 'MB92 - Barcelona', inTypeId: 1, outTypeId: 2 }
const MPV: AlmacenOdoo = { warehouseId: 2, codigo: 'MPV', nombre: 'MPV - Port Vell', inTypeId: 9, outTypeId: 10 }
const TGN: AlmacenOdoo = { warehouseId: 4, codigo: 'TGN', nombre: 'TGN - Port Tarraco', inTypeId: 25, outTypeId: 26 }
const COPIA: AlmacenOdoo = { warehouseId: 8, codigo: 'COPIA', nombre: 'DECK - MB92 Barcelona', inTypeId: 57, outTypeId: 58 }

const AHORA = new Date('2026-10-22T10:00:00.000Z')
const ANTES = new Date('2026-01-01T00:00:00.000Z')

/**
 * What the four Odoo reads answer. A section left out answers an empty list, which
 * refreshMaestros treats as "nothing to say" and does not touch, so each test can
 * focus on the section it is about.
 */
function odooResponde(datos: {
  almacenes?: AlmacenOdoo[]
  couriers?: CourierOdoo[]
  barcos?: BarcoOdoo[]
  uso?: UsoCourierOdoo[]
}) {
  vi.mocked(fetchAlmacenes).mockResolvedValue(datos.almacenes ?? [])
  vi.mocked(fetchCouriers).mockResolvedValue(datos.couriers ?? [])
  vi.mocked(fetchBarcos).mockResolvedValue(datos.barcos ?? [])
  vi.mocked(fetchUsoCouriers).mockResolvedValue(datos.uso ?? [])
}

const almacenPorPrefijo = async (prefijo: string) =>
  (await db.select().from(almacenes).where(eq(almacenes.prefijo, prefijo)))[0]
const courierPorProducto = async (productId: number) =>
  (await db.select().from(couriers).where(eq(couriers.odooProductId, productId)))[0]
const barcoPorOdooId = async (odooId: number) =>
  (await db.select().from(barcosCache).where(eq(barcosCache.odooId, odooId)))[0]

beforeEach(async () => {
  vi.resetAllMocks()
  odooResponde({})
  await resetTestDb(db as unknown as TestDb)
})

describe('almacenes', () => {
  it('links existing almacenes by prefijo on the first refresh and keeps their ids', async () => {
    // MLC takes id 1, so MB92 gets id 2 and cannot be mistaken for Odoo warehouse 1.
    await seedAlmacen(db, { prefijo: 'MLC', odooWarehouseId: null, odooInTypeId: null, odooOutTypeId: null })
    const mb92 = await seedAlmacen(db, { prefijo: 'MB92', odooWarehouseId: null, odooInTypeId: 99, odooOutTypeId: null })
    const operario = await seedOperario(db)
    await db.insert(operarioAlmacenes).values({ operarioId: operario.id, almacenId: mb92.id })
    odooResponde({ almacenes: [MB92] })

    await refreshMaestros()

    const fila = await db.query.almacenes.findFirst({ where: eq(almacenes.id, mb92.id) })
    expect(fila).toMatchObject({
      prefijo: 'MB92', nombre: 'MB92 - Barcelona', odooWarehouseId: 1, odooInTypeId: 1, odooOutTypeId: 2, activo: true,
    })
    expect(await db.select().from(almacenes).where(eq(almacenes.prefijo, 'MB92'))).toHaveLength(1) // linked, not duplicated
    expect(await db.select().from(operarioAlmacenes)).toEqual([{ operarioId: operario.id, almacenId: mb92.id }])
  })

  it('deactivates almacenes Odoo no longer has (MLC) and adds new ones (TGN, COPIA)', async () => {
    const mb92 = await seedAlmacen(db)
    const mlc = await seedAlmacen(db, {
      prefijo: 'MLC', nombre: 'Mallorca (MLC)', odooWarehouseId: null, odooInTypeId: null, odooOutTypeId: null,
    })
    const operario = await seedOperario(db)
    await db.insert(operarioAlmacenes).values({ operarioId: operario.id, almacenId: mlc.id })
    odooResponde({ almacenes: [MB92, TGN, COPIA] })

    await refreshMaestros()

    expect(await almacenPorPrefijo('MB92')).toMatchObject({ id: mb92.id, activo: true })
    expect(await almacenPorPrefijo('MLC')).toMatchObject({ id: mlc.id, activo: false })
    expect(await almacenPorPrefijo('TGN')).toMatchObject({
      nombre: 'TGN - Port Tarraco', odooWarehouseId: 4, odooInTypeId: 25, odooOutTypeId: 26, activo: true,
    })
    expect(await almacenPorPrefijo('COPIA')).toMatchObject({
      nombre: 'DECK - MB92 Barcelona', odooWarehouseId: 8, odooInTypeId: 57, odooOutTypeId: 58, activo: true,
    })
    expect(await db.select().from(almacenes)).toHaveLength(4)
    // The operario keeps the assignment to the deactivated almacén: nothing is deleted.
    expect(await db.select().from(operarioAlmacenes)).toHaveLength(1)
  })

  it('keeps following a warehouse by its Odoo id when its code, name and types change', async () => {
    const mb92 = await seedAlmacen(db)
    odooResponde({ almacenes: [{ ...MB92, codigo: 'MB93', nombre: 'MB93 - Barcelona', inTypeId: 5, outTypeId: 6 }] })

    await refreshMaestros()

    expect(await db.select().from(almacenes)).toEqual([{
      id: mb92.id, prefijo: 'MB93', nombre: 'MB93 - Barcelona',
      odooWarehouseId: 1, odooInTypeId: 5, odooOutTypeId: 6, activo: true,
    }])
  })

  it('reactivates an almacén that is back in Odoo', async () => {
    const mb92 = await seedAlmacen(db, { activo: false })
    odooResponde({ almacenes: [MB92] })

    await refreshMaestros()

    expect(await almacenPorPrefijo('MB92')).toMatchObject({ id: mb92.id, activo: true })
  })

  it('gives the same result when it runs again', async () => {
    await seedAlmacen(db, { prefijo: 'MB92', odooWarehouseId: null, odooOutTypeId: null })
    odooResponde({ almacenes: [MB92, MPV, TGN] })

    await refreshMaestros()
    const primera = await db.select().from(almacenes).orderBy(asc(almacenes.id))
    await refreshMaestros()

    expect(await db.select().from(almacenes).orderBy(asc(almacenes.id))).toEqual(primera)
    expect(primera).toHaveLength(3)
  })
})

describe('couriers', () => {
  it('upserts couriers by product id: renames, adds and deactivates', async () => {
    const amazon = await seedCourier(db, { nombre: 'Amazon', odooProductId: 11 })
    await seedCourier(db, { nombre: 'UPS', odooProductId: 21 })
    odooResponde({ couriers: [{ productId: 11, nombre: 'DHL' }, { productId: 125, nombre: 'UPS (correcto)' }] })

    await refreshMaestros()

    expect(await courierPorProducto(11)).toMatchObject({ id: amazon.id, nombre: 'DHL', activo: true })
    expect(await courierPorProducto(21)).toMatchObject({ nombre: 'UPS', activo: false })
    expect(await courierPorProducto(125)).toMatchObject({ nombre: 'UPS (correcto)', activo: true })
    expect(await db.select().from(couriers)).toHaveLength(3)
  })

  it('deactivates couriers that were never linked to an Odoo product', async () => {
    await seedCourier(db, { nombre: 'Correos', odooProductId: null })
    odooResponde({ couriers: [{ productId: 11, nombre: 'DHL' }] })

    await refreshMaestros()

    expect(await db.select().from(couriers).where(eq(couriers.nombre, 'Correos'))).toMatchObject([{ activo: false }])
    expect(await courierPorProducto(11)).toMatchObject({ activo: true })
  })

  it('keeps both products when two couriers share a name', async () => {
    odooResponde({ couriers: [{ productId: 11, nombre: 'DHL' }, { productId: 104, nombre: 'DHL' }] })

    await refreshMaestros()

    expect(await db.select().from(couriers).where(eq(couriers.nombre, 'DHL'))).toHaveLength(2)
  })

  it('reactivates a courier that is serial-tracked in Odoo again', async () => {
    await seedCourier(db, { activo: false })
    odooResponde({ couriers: [{ productId: 11, nombre: 'DHL' }] })

    await refreshMaestros()

    expect(await courierPorProducto(11)).toMatchObject({ activo: true })
  })
})

describe('courier_uso', () => {
  const COURIERS = [{ productId: 11, nombre: 'DHL' }, { productId: 69, nombre: 'Chronopost' }]

  it('replaces courier_uso with per-almacén counts', async () => {
    const mb92 = await seedAlmacen(db)
    const mpv = await seedAlmacen(db, {
      prefijo: 'MPV', nombre: 'MPV - Port Vell', odooWarehouseId: 2, odooInTypeId: 9, odooOutTypeId: 10,
    })
    const dhl = await seedCourier(db)
    const chronopost = await seedCourier(db, { nombre: 'Chronopost', odooProductId: 69 })
    await db.insert(courierUso).values([
      { almacenId: mb92.id, courierId: dhl.id, usos: 99 }, // old counts: must go
      { almacenId: mpv.id, courierId: dhl.id, usos: 5 },
    ])
    odooResponde({
      almacenes: [MB92, MPV],
      couriers: COURIERS,
      uso: [
        { inTypeId: 1, productId: 11, usos: 7 },
        { inTypeId: 1, productId: 69, usos: 2 },
        { inTypeId: 9, productId: 69, usos: 4 },
        { inTypeId: 777, productId: 11, usos: 3 }, // not the reception type of any almacén
        { inTypeId: 1, productId: 555, usos: 1 }, // not a courier we know
      ],
    })

    await refreshMaestros(AHORA)

    const filas = await db.select().from(courierUso)
    expect(filas).toHaveLength(3)
    expect(filas).toEqual(expect.arrayContaining([
      { almacenId: mb92.id, courierId: dhl.id, usos: 7 },
      { almacenId: mb92.id, courierId: chronopost.id, usos: 2 },
      { almacenId: mpv.id, courierId: chronopost.id, usos: 4 },
    ]))
  })

  it('counts the last 90 days before the refresh', async () => {
    odooResponde({})
    await refreshMaestros(AHORA)

    expect(DIAS_USO_COURIERS).toBe(90)
    expect(fetchUsoCouriers).toHaveBeenCalledTimes(1)
    expect(fetchUsoCouriers).toHaveBeenCalledWith(new Date('2026-07-24T10:00:00.000Z'))
  })

  it('maps counts only to almacenes and couriers that are active', async () => {
    const mb92 = await seedAlmacen(db)
    // A hand-made leftover that still points at reception type 1 and is no longer active.
    await seedAlmacen(db, { prefijo: 'MLC', odooWarehouseId: null, odooInTypeId: 1, activo: false })
    const dhl = await seedCourier(db)
    await seedCourier(db, { nombre: 'Viejo', odooProductId: 15, activo: false })
    odooResponde({
      uso: [{ inTypeId: 1, productId: 11, usos: 7 }, { inTypeId: 1, productId: 15, usos: 2 }],
    })

    await refreshMaestros()

    expect(await db.select().from(courierUso)).toEqual([{ almacenId: mb92.id, courierId: dhl.id, usos: 7 }])
  })

  it('keeps the old counts when none of the counted lines belongs to a known almacén and courier', async () => {
    const mb92 = await seedAlmacen(db)
    const dhl = await seedCourier(db)
    await db.insert(courierUso).values({ almacenId: mb92.id, courierId: dhl.id, usos: 4 })
    odooResponde({ uso: [{ inTypeId: 777, productId: 555, usos: 9 }] })

    await refreshMaestros()

    expect(await db.select().from(courierUso)).toEqual([{ almacenId: mb92.id, courierId: dhl.id, usos: 4 }])
  })
})

describe('barcos', () => {
  it('marks barcos missing in Odoo as inactive and renames the rest', async () => {
    await seedBarco(db, { odooId: 673, nombre: 'MAYANQUEEN', updatedAt: ANTES })
    await seedBarco(db, { odooId: 674, nombre: 'MAYANQUEENIV', updatedAt: ANTES })
    await seedBarco(db, { odooId: 700, nombre: 'REGRESO', activo: false, updatedAt: ANTES })
    odooResponde({
      barcos: [
        { odooId: 673, nombre: 'MAYAN QUEEN' },
        { odooId: 700, nombre: 'REGRESO' },
        { odooId: 951, nombre: 'NUEVO' },
      ],
    })

    await refreshMaestros(AHORA)

    expect(await barcoPorOdooId(673)).toMatchObject({ nombre: 'MAYAN QUEEN', activo: true, updatedAt: AHORA })
    expect(await barcoPorOdooId(674)).toMatchObject({ nombre: 'MAYANQUEENIV', activo: false, updatedAt: ANTES })
    expect(await barcoPorOdooId(700)).toMatchObject({ nombre: 'REGRESO', activo: true, updatedAt: AHORA })
    expect(await barcoPorOdooId(951)).toMatchObject({ nombre: 'NUEVO', activo: true, updatedAt: AHORA })
    expect(await db.select().from(barcosCache)).toHaveLength(4)
  })

  it('keeps two barcos that share a name, each with its own Odoo id', async () => {
    odooResponde({ barcos: [{ odooId: 942, nombre: 'H3' }, { odooId: 943, nombre: 'H3' }] })

    await refreshMaestros()

    expect(await db.select().from(barcosCache).where(eq(barcosCache.nombre, 'H3'))).toHaveLength(2)
  })
})

describe('empty answers', () => {
  it('leaves a section untouched when Odoo returns an empty list', async () => {
    const mb92 = await seedAlmacen(db)
    const dhl = await seedCourier(db)
    await seedBarco(db, { updatedAt: ANTES })
    await db.insert(courierUso).values({ almacenId: mb92.id, courierId: dhl.id, usos: 4 })
    odooResponde({})

    const resumen = await refreshMaestros(AHORA)

    expect(resumen).toEqual({ almacenes: 0, couriers: 0, barcos: 0 })
    expect(await db.select().from(almacenes)).toMatchObject([{ id: mb92.id, activo: true }])
    expect(await db.select().from(couriers)).toMatchObject([{ id: dhl.id, nombre: 'DHL', activo: true }])
    expect(await db.select().from(barcosCache)).toMatchObject([{ odooId: 673, activo: true, updatedAt: ANTES }])
    expect(await db.select().from(courierUso)).toEqual([{ almacenId: mb92.id, courierId: dhl.id, usos: 4 }])
  })

  it('refreshes the sections that answered even when another one came back empty', async () => {
    await seedAlmacen(db)
    await seedCourier(db)
    odooResponde({ barcos: [{ odooId: 951, nombre: 'NUEVO' }] })

    const resumen = await refreshMaestros(AHORA)

    expect(resumen).toEqual({ almacenes: 0, couriers: 0, barcos: 1 })
    expect(await almacenPorPrefijo('MB92')).toMatchObject({ activo: true })
    expect(await courierPorProducto(11)).toMatchObject({ activo: true })
    expect(await barcoPorOdooId(951)).toMatchObject({ nombre: 'NUEVO', activo: true })
  })
})

describe('refreshMaestros', () => {
  it('reports how many almacenes, couriers and barcos Odoo sent', async () => {
    odooResponde({
      almacenes: [MB92, MPV],
      couriers: [{ productId: 11, nombre: 'DHL' }, { productId: 69, nombre: 'Chronopost' }, { productId: 125, nombre: 'UPS' }],
      barcos: [{ odooId: 673, nombre: 'MAYANQUEEN' }],
    })

    expect(await refreshMaestros()).toEqual({ almacenes: 2, couriers: 3, barcos: 1 })
  })

  it('reads Odoo once per section, in a fixed order: almacenes, couriers, barcos, usage', async () => {
    await refreshMaestros()

    const lecturas = [fetchAlmacenes, fetchCouriers, fetchBarcos, fetchUsoCouriers]
    lecturas.forEach((lectura) => expect(lectura).toHaveBeenCalledTimes(1))
    const orden = lecturas.map((lectura) => vi.mocked(lectura).mock.invocationCallOrder[0])
    expect(orden).toEqual([...orden].sort((a, b) => a - b))
  })

  it('lets an Odoo failure through, after keeping what was already refreshed', async () => {
    odooResponde({ almacenes: [MB92], couriers: [{ productId: 11, nombre: 'DHL' }] })
    vi.mocked(fetchBarcos).mockRejectedValue(new Error('Odoo no respondió'))

    await expect(refreshMaestros()).rejects.toThrow('Odoo no respondió')

    expect(await almacenPorPrefijo('MB92')).toMatchObject({ activo: true })
    expect(await courierPorProducto(11)).toMatchObject({ nombre: 'DHL' })
    expect(fetchUsoCouriers).not.toHaveBeenCalled()
  })
})

describe('ultimoRefresco', () => {
  it('is null while no barco has been cached', async () => {
    expect(await ultimoRefresco()).toBeNull()
  })

  it('is the latest time a barco was refreshed', async () => {
    await seedBarco(db, { odooId: 1, updatedAt: new Date('2026-10-01T00:00:00.000Z') })
    await seedBarco(db, { odooId: 2, updatedAt: new Date('2026-10-20T08:30:00.000Z') })

    expect(await ultimoRefresco()).toEqual(new Date('2026-10-20T08:30:00.000Z'))
  })

  it('moves to the time of the last refresh', async () => {
    await seedBarco(db, { updatedAt: ANTES })
    odooResponde({ barcos: [{ odooId: 673, nombre: 'MAYANQUEEN' }] })

    await refreshMaestros(AHORA)

    expect(await ultimoRefresco()).toEqual(AHORA)
  })
})
