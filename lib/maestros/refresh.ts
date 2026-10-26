import { count, eq, isNull, max, notInArray, or, sql, type AnyColumn } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, barcosCache, courierUso, couriers } from '../../db/schema'
import {
  fetchAlmacenes, fetchBarcos, fetchCouriers, fetchUsoCouriers,
  type AlmacenOdoo, type BarcoOdoo, type CourierOdoo, type UsoCourierOdoo,
} from '../odoo/maestros'

/** How many days back the per-almacén courier counts look. */
export const DIAS_USO_COURIERS = 90
const MS_POR_DIA = 24 * 60 * 60 * 1000

/** How many records Odoo sent per section. 0: the section came back empty and was left as it was. */
export interface ResumenRefresco {
  almacenes: number
  couriers: number
  barcos: number
}

/**
 * Brings almacenes, couriers and barcos in line with Odoo and recounts which couriers
 * each almacén receives most. Odoo is read four times, in this order: almacenes,
 * couriers, barcos, usage (`odooCall` spaces the reads 1 s apart). Each section is
 * written as soon as it has been read, so a failing later read keeps the earlier ones.
 *
 * What Odoo no longer has stays in its table with `activo = false` and is never
 * deleted: sessions and operario assignments point at it. An empty answer is not read
 * as "Odoo has none" (more likely a failed or filtered read): that section is left
 * untouched instead of deactivating everything.
 */
export async function refreshMaestros(ahora: Date = new Date()): Promise<ResumenRefresco> {
  const almacenesOdoo = await fetchAlmacenes()
  await guardarAlmacenes(almacenesOdoo)

  const couriersOdoo = await fetchCouriers()
  await guardarCouriers(couriersOdoo)

  const barcosOdoo = await fetchBarcos()
  await guardarBarcos(barcosOdoo, ahora)

  const desde = new Date(ahora.getTime() - DIAS_USO_COURIERS * MS_POR_DIA)
  await guardarUso(await fetchUsoCouriers(desde))

  return { almacenes: almacenesOdoo.length, couriers: couriersOdoo.length, barcos: barcosOdoo.length }
}

/** When the barcos were last refreshed from Odoo; null while none has been. */
export async function ultimoRefresco(): Promise<Date | null> {
  const [fila] = await db.select({ ultimo: max(barcosCache.updatedAt) }).from(barcosCache)
  return fila?.ultimo ?? null
}

/** How many almacenes and couriers are active: the ones Odoo has, as of the last refresh. */
export async function contarMaestrosActivos(): Promise<{ almacenes: number; couriers: number }> {
  const [[delAlmacen], [delCourier]] = await Promise.all([
    db.select({ total: count() }).from(almacenes).where(eq(almacenes.activo, true)),
    db.select({ total: count() }).from(couriers).where(eq(couriers.activo, true)),
  ])
  return { almacenes: delAlmacen.total, couriers: delCourier.total }
}

/** Inside `ON CONFLICT DO UPDATE`: the value the INSERT proposed for `columna`, i.e. what Odoo just sent. */
function excluido(columna: AnyColumn) {
  return sql`excluded.${sql.identifier(columna.name)}`
}

async function guardarAlmacenes(delOdoo: AlmacenOdoo[]): Promise<void> {
  if (delOdoo.length === 0) return
  const existentes = await db.select().from(almacenes)

  for (const w of delOdoo) {
    const valores = {
      prefijo: w.codigo,
      nombre: w.nombre,
      odooWarehouseId: w.warehouseId,
      odooInTypeId: w.inTypeId,
      odooOutTypeId: w.outTypeId,
      activo: true,
    }
    // The Odoo id is the key. The rows made by hand before this refresh existed have none
    // yet: they are found once by prefijo and linked, so they keep their id and the
    // operarios assigned to it.
    const actual =
      existentes.find((a) => a.odooWarehouseId === w.warehouseId) ??
      existentes.find((a) => a.odooWarehouseId === null && a.prefijo === w.codigo)
    if (actual) await db.update(almacenes).set(valores).where(eq(almacenes.id, actual.id))
    else await db.insert(almacenes).values(valores)
  }

  // Every almacén Odoo sent has its warehouse id by now: the rest (MLC never existed in Odoo) is out.
  await db.update(almacenes).set({ activo: false }).where(
    or(isNull(almacenes.odooWarehouseId), notInArray(almacenes.odooWarehouseId, delOdoo.map((w) => w.warehouseId))),
  )
}

async function guardarCouriers(delOdoo: CourierOdoo[]): Promise<void> {
  if (delOdoo.length === 0) return
  await db.batch([
    db.insert(couriers)
      .values(delOdoo.map((c) => ({ odooProductId: c.productId, nombre: c.nombre, activo: true })))
      .onConflictDoUpdate({
        target: couriers.odooProductId,
        set: { nombre: excluido(couriers.nombre), activo: true },
      }),
    // The ones Odoo no longer lists, and the ones typed in by hand that never had a product.
    db.update(couriers).set({ activo: false }).where(
      or(isNull(couriers.odooProductId), notInArray(couriers.odooProductId, delOdoo.map((c) => c.productId))),
    ),
  ])
}

async function guardarBarcos(delOdoo: BarcoOdoo[], ahora: Date): Promise<void> {
  if (delOdoo.length === 0) return
  await db.batch([
    db.insert(barcosCache)
      .values(delOdoo.map((b) => ({ odooId: b.odooId, nombre: b.nombre, activo: true, updatedAt: ahora })))
      .onConflictDoUpdate({
        target: barcosCache.odooId,
        // `excluded.nombre` is the incoming name; naming the column itself would copy the old
        // value onto itself and a renamed barco would never update.
        set: { nombre: excluido(barcosCache.nombre), activo: true, updatedAt: ahora },
      }),
    // Their updatedAt stays at the last time Odoo had them.
    db.update(barcosCache).set({ activo: false }).where(notInArray(barcosCache.odooId, delOdoo.map((b) => b.odooId))),
  ])
}

async function guardarUso(delOdoo: UsoCourierOdoo[]): Promise<void> {
  if (delOdoo.length === 0) return

  // Only active ones: a hand-made leftover can still point at a reception type
  // that now belongs to another almacén.
  const almacenesActivos = await db.select({ id: almacenes.id, inTypeId: almacenes.odooInTypeId })
    .from(almacenes).where(eq(almacenes.activo, true))
  const couriersActivos = await db.select({ id: couriers.id, productId: couriers.odooProductId })
    .from(couriers).where(eq(couriers.activo, true))

  const almacenPorTipo = new Map<number, number>()
  for (const a of almacenesActivos) if (a.inTypeId !== null) almacenPorTipo.set(a.inTypeId, a.id)
  const courierPorProducto = new Map<number, number>()
  for (const c of couriersActivos) if (c.productId !== null) courierPorProducto.set(c.productId, c.id)

  // Counts of a reception type or a product the app does not know are dropped.
  const filas = delOdoo.flatMap((u) => {
    const almacenId = almacenPorTipo.get(u.inTypeId)
    const courierId = courierPorProducto.get(u.productId)
    return almacenId !== undefined && courierId !== undefined ? [{ almacenId, courierId, usos: u.usos }] : []
  })
  // Nothing to write is treated like an empty answer: the old counts are better than none.
  if (filas.length === 0) return

  await db.batch([db.delete(courierUso), db.insert(courierUso).values(filas)])
}
