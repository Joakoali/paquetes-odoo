import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, operarioAlmacenes, type Almacen } from '../../db/schema'

export async function getAlmacenesForOperario(operarioId: string): Promise<Almacen[]> {
  const links = await db.query.operarioAlmacenes.findMany({
    where: eq(operarioAlmacenes.operarioId, operarioId),
  })
  if (links.length === 0) return []
  const ids = links.map((l) => l.almacenId)
  return db.select().from(almacenes).where(inArray(almacenes.id, ids))
}

/**
 * Server-side authorization check for spec §6: an operario may only work in the
 * almacenes assigned to them. The UI merely hides the others.
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
