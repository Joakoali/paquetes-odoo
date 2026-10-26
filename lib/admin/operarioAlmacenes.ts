import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, operarioAlmacenes, type Almacen } from '../../db/schema'

/**
 * The almacenes the operario can work in: the assigned ones that are still active (an almacén
 * Odoo no longer has stays assigned but cannot be worked in), by name. The order is part of the
 * contract: the first one is the default almacén when the device has not chosen another.
 */
export async function getAlmacenesForOperario(operarioId: string): Promise<Almacen[]> {
  const filas = await db.select({ almacen: almacenes })
    .from(operarioAlmacenes)
    .innerJoin(almacenes, eq(almacenes.id, operarioAlmacenes.almacenId))
    .where(and(eq(operarioAlmacenes.operarioId, operarioId), eq(almacenes.activo, true)))
    // lower() so that capitals do not sort apart under the C collation, as in searchBarcos;
    // the id last so that two almacenes with the same name always come in the same order.
    .orderBy(asc(sql`lower(${almacenes.nombre})`), asc(almacenes.id))
  return filas.map((fila) => fila.almacen)
}

/** Every almacén that is still active, by name, like `getAlmacenesForOperario`: what the admin can assign. */
export async function listAlmacenesActivos(): Promise<Almacen[]> {
  return db.select().from(almacenes)
    .where(eq(almacenes.activo, true))
    .orderBy(asc(sql`lower(${almacenes.nombre})`), asc(almacenes.id))
}

/**
 * Server-side authorization check for spec §6: an operario may only work in the
 * almacenes assigned to them. The UI merely hides the others. It looks at the
 * assignment only: an almacén that went inactive stays reachable for what is already open in it.
 */
export async function operarioHasAlmacen(operarioId: string, almacenId: number): Promise<boolean> {
  const row = await db.query.operarioAlmacenes.findFirst({
    where: (l, { and, eq: e }) => and(e(l.operarioId, operarioId), e(l.almacenId, almacenId)),
  })
  return row !== undefined && row !== null
}

/**
 * Replaces the operario's links to the ACTIVE almacenes with `almacenIds`. The links to almacenes that
 * went inactive are not touched: the admin form only shows the active ones (`getAlmacenesForOperario`),
 * so a save cannot speak for the rest, and dropping them would lose the assignment of an almacén that
 * Odoo later brings back.
 */
export async function setAlmacenesForOperario(operarioId: string, almacenIds: number[]): Promise<void> {
  const delActivos = db.delete(operarioAlmacenes).where(and(
    eq(operarioAlmacenes.operarioId, operarioId),
    inArray(operarioAlmacenes.almacenId, db.select({ id: almacenes.id }).from(almacenes).where(eq(almacenes.activo, true))),
  ))
  if (almacenIds.length === 0) {
    await delActivos
    return
  }

  // Delete-then-insert must be atomic: a failure between the two would leave
  // the operario with no almacenes at all. `db.batch` is neon-http's atomic
  // primitive — the driver has no `transaction()` (it throws outright).
  await db.batch([
    delActivos,
    // A form drawn before a refresh can still send an almacén that has gone inactive since, and the operario
    // keeps that link: it is already there, and not a reason to fail the save.
    db.insert(operarioAlmacenes)
      .values([...new Set(almacenIds)].map((almacenId) => ({ operarioId, almacenId })))
      .onConflictDoNothing(),
  ])
}
