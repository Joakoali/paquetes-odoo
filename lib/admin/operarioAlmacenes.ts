import { and, asc, eq, sql } from 'drizzle-orm'
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

export async function setAlmacenesForOperario(operarioId: string, almacenIds: number[]): Promise<void> {
  const del = db.delete(operarioAlmacenes).where(eq(operarioAlmacenes.operarioId, operarioId))
  if (almacenIds.length === 0) {
    await del
    return
  }

  // Delete-then-insert must be atomic: a failure between the two would leave
  // the operario with no almacenes at all. `db.batch` is neon-http's atomic
  // primitive — the driver has no `transaction()` (it throws outright).
  await db.batch([
    del,
    db.insert(operarioAlmacenes).values(almacenIds.map((almacenId) => ({ operarioId, almacenId }))),
  ])
}
