import { describe, it, expect, vi, beforeEach } from 'vitest'
import { count, getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'

// The pattern every DB-backed test follows: the app's `db` becomes an in-memory
// Postgres (PGlite) with the real migrations applied.
vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))

import { db } from '@/db/client'
import * as schema from '@/db/schema'
import {
  auditLog, courierUso, couriers, operarioAlmacenes, sesionCourierBatches,
  sesionesAuth, sesionesEscaneo, sesionItems, trackingActivosCache,
} from '@/db/schema'
import { resetTestDb, type TestDb } from './test-db'
import { seedAlmacen, seedBarco, seedCourier, seedOperario } from './seed'

beforeEach(() => resetTestDb(db as unknown as TestDb))

// drizzle wraps the driver error in a DrizzleQueryError; the violated constraint is on `cause`.
const violating = (constraint: string) => ({ cause: { constraint } })

describe('partial unique index on open recepciones', () => {
  it('rejects a second open recepción for the same almacén and barco', async () => {
    const op = await seedOperario(db); const mb92 = await seedAlmacen(db)
    const base = { operarioId: op.id, almacenId: mb92.id, barcoOdooId: 673, tipo: 'recepcion' as const }
    await db.insert(sesionesEscaneo).values(base)
    await expect(db.insert(sesionesEscaneo).values(base))
      .rejects.toMatchObject(violating('sesiones_recepcion_abierta_unica'))
    await db.insert(sesionesEscaneo).values({ ...base, estado: 'sincronizada' }) // does not clash: not en_curso
  })

  it('only restricts recepciones: other barcos, other almacenes and entregas are unaffected', async () => {
    const op = await seedOperario(db)
    const mb92 = await seedAlmacen(db)
    const ibz = await seedAlmacen(db, { prefijo: 'IBZ', odooWarehouseId: 2, odooInTypeId: 3, odooOutTypeId: 4 })
    const base = { operarioId: op.id, almacenId: mb92.id, barcoOdooId: 673, tipo: 'recepcion' as const }
    await db.insert(sesionesEscaneo).values(base)
    await db.insert(sesionesEscaneo).values({ ...base, barcoOdooId: 674 })
    await db.insert(sesionesEscaneo).values({ ...base, almacenId: ibz.id })
    await db.insert(sesionesEscaneo).values({ ...base, tipo: 'entrega' })
    await db.insert(sesionesEscaneo).values({ ...base, tipo: 'entrega' })
    expect(await db.select().from(sesionesEscaneo)).toHaveLength(5) // all open at once
  })
})

describe('migrated schema constraints', () => {
  it('allows couriers that share a name, but not an Odoo product', async () => {
    await seedCourier(db)
    await seedCourier(db, { odooProductId: 12 }) // same name "DHL": nombre is no longer unique
    await expect(seedCourier(db, { nombre: 'UPS' })) // product 11 again
      .rejects.toMatchObject(violating('couriers_odoo_product_id_unique'))
  })

  it('maps each Odoo warehouse to a single almacén', async () => {
    await seedAlmacen(db)
    await expect(seedAlmacen(db, { prefijo: 'IBZ' })) // warehouse 1 again
      .rejects.toMatchObject(violating('almacenes_odoo_warehouse_id_unique'))
  })

  it('allows a single batch per courier in a session', async () => {
    const op = await seedOperario(db); const mb92 = await seedAlmacen(db); const dhl = await seedCourier(db)
    const [sesion] = await db.insert(sesionesEscaneo)
      .values({ operarioId: op.id, almacenId: mb92.id, barcoOdooId: 673, tipo: 'recepcion' }).returning()
    const batch = { sesionId: sesion.id, courierId: dhl.id }
    await db.insert(sesionCourierBatches).values(batch)
    await expect(db.insert(sesionCourierBatches).values(batch))
      .rejects.toMatchObject(violating('sesion_courier_batches_sesion_id_courier_id_unique'))
  })

  it('keeps one courier_uso counter per almacén and courier', async () => {
    const mb92 = await seedAlmacen(db); const dhl = await seedCourier(db)
    const uso = { almacenId: mb92.id, courierId: dhl.id }
    await db.insert(courierUso).values({ ...uso, usos: 1 })
    await expect(db.insert(courierUso).values({ ...uso, usos: 1 }))
      .rejects.toMatchObject(violating('courier_uso_almacen_id_courier_id_pk'))
  })
})

describe('resetTestDb', () => {
  it('empties every table and restarts identities', async () => {
    const op = await seedOperario(db)
    const mb92 = await seedAlmacen(db)
    const dhl = await seedCourier(db)
    await seedBarco(db)
    const [sesion] = await db.insert(sesionesEscaneo)
      .values({ operarioId: op.id, almacenId: mb92.id, barcoOdooId: 673, tipo: 'recepcion' }).returning()
    const [batch] = await db.insert(sesionCourierBatches)
      .values({ sesionId: sesion.id, courierId: dhl.id }).returning()
    await db.insert(sesionItems).values({ courierBatchId: batch.id, trackingNumber: 'T1' })
    await db.insert(sesionesAuth).values({ operarioId: op.id, expiresAt: new Date() })
    await db.insert(operarioAlmacenes).values({ operarioId: op.id, almacenId: mb92.id })
    await db.insert(courierUso).values({ almacenId: mb92.id, courierId: dhl.id, usos: 1 })
    await db.insert(trackingActivosCache).values({ trackingNumber: 'T1', odooPickingId: 1 })
    await db.insert(auditLog).values({ accion: 'test' })

    await resetTestDb(db as unknown as TestDb)

    const tables = Object.values<unknown>(schema).filter((v): v is PgTable => is(v, PgTable))
    expect(tables.map((t) => getTableName(t))).toEqual(expect.arrayContaining(['operarios', 'courier_uso']))
    for (const table of tables) {
      const [{ n }] = await db.select({ n: count() }).from(table)
      expect(n, getTableName(table)).toBe(0)
    }
    expect((await seedAlmacen(db)).id).toBe(1)
  })

  it('refuses to truncate anything that is not the in-memory database', async () => {
    const execute = vi.fn()
    // What a test that forgot to mock '@/db/client' would hand over: the neon db, whose `$client` is a query function.
    const neonLike = { $client: () => {}, execute } as unknown as TestDb
    await expect(resetTestDb(neonLike)).rejects.toThrow(/PGlite/)
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('TestDb.batch', () => {
  it('awaits the queries in order and returns their results in the same order', async () => {
    const testDb = db as unknown as TestDb
    const [dhl, ups] = await testDb.batch([
      testDb.insert(couriers).values({ nombre: 'DHL' }).returning(),
      testDb.insert(couriers).values({ nombre: 'UPS' }).returning(),
    ])
    expect(dhl[0].nombre).toBe('DHL')
    expect(ups[0].nombre).toBe('UPS')
    expect(dhl[0].id).toBeLessThan(ups[0].id)
  })

  it('does not run the queries that come after a failing one', async () => {
    const testDb = db as unknown as TestDb
    await expect(testDb.batch([
      testDb.insert(couriers).values({ nombre: 'DHL', odooProductId: 11 }),
      testDb.insert(couriers).values({ nombre: 'UPS', odooProductId: 11 }), // product 11 taken
      testDb.insert(couriers).values({ nombre: 'GLS', odooProductId: 12 }),
    ])).rejects.toMatchObject(violating('couriers_odoo_product_id_unique'))
    expect((await db.select().from(couriers)).map((c) => c.nombre)).not.toContain('GLS')
  })
})

describe('seeds', () => {
  it('return the inserted row with the documented defaults', async () => {
    expect(await seedOperario(db)).toMatchObject({ rol: 'operario', activo: true })
    expect(await seedAlmacen(db)).toMatchObject({
      prefijo: 'MB92', odooWarehouseId: 1, odooInTypeId: 1, odooOutTypeId: 2, activo: true,
    })
    expect(await seedCourier(db)).toMatchObject({ nombre: 'DHL', odooProductId: 11, activo: true })
    expect(await seedBarco(db)).toMatchObject({ odooId: 673, nombre: 'MAYANQUEEN', activo: true })
  })

  it('generate a unique login per operario and accept overrides', async () => {
    const a = await seedOperario(db)
    const b = await seedOperario(db, { nombre: 'Ana', rol: 'admin' })
    expect(b.login).not.toBe(a.login)
    expect(b).toMatchObject({ nombre: 'Ana', rol: 'admin' })
  })
})
