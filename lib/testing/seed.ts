import type { PgDatabase } from 'drizzle-orm/pg-core'
import {
  almacenes, barcosCache, couriers, operarios,
  type Almacen, type BarcoCache, type Courier, type Operario,
} from '@/db/schema'
import type * as schema from '@/db/schema'

// Anything drizzle-pg shaped: the app's neon `db` as seen through the mocked
// `@/db/client`, or a `TestDb`.
type Db = PgDatabase<any, typeof schema>

let seededOperarios = 0

/** Inserts an operario with a unique login. Overrides go in `datos`. */
export async function seedOperario(db: Db, datos: Partial<typeof operarios.$inferInsert> = {}): Promise<Operario> {
  seededOperarios += 1
  const [row] = await db.insert(operarios).values({
    nombre: `Operario ${seededOperarios}`,
    login: `operario-${seededOperarios}`,
    passwordHash: 'test-password-hash',
    ...datos,
  }).returning()
  return row
}

/** Inserts the MB92 almacén (Odoo warehouse 1, in type 1, out type 2) unless overridden. */
export async function seedAlmacen(db: Db, datos: Partial<typeof almacenes.$inferInsert> = {}): Promise<Almacen> {
  const [row] = await db.insert(almacenes).values({
    prefijo: 'MB92',
    nombre: 'Barcelona (MB92)',
    odooWarehouseId: 1,
    odooInTypeId: 1,
    odooOutTypeId: 2,
    ...datos,
  }).returning()
  return row
}

/** Inserts the DHL courier (Odoo product 11) unless overridden. */
export async function seedCourier(db: Db, datos: Partial<typeof couriers.$inferInsert> = {}): Promise<Courier> {
  const [row] = await db.insert(couriers).values({
    nombre: 'DHL',
    odooProductId: 11,
    ...datos,
  }).returning()
  return row
}

/** Inserts the barco MAYANQUEEN (Odoo project 673) unless overridden. */
export async function seedBarco(db: Db, datos: Partial<typeof barcosCache.$inferInsert> = {}): Promise<BarcoCache> {
  const [row] = await db.insert(barcosCache).values({
    odooId: 673,
    nombre: 'MAYANQUEEN',
    ...datos,
  }).returning()
  return row
}
