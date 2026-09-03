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

export async function setAlmacenesForOperario(operarioId: string, almacenIds: number[]): Promise<void> {
  await db.delete(operarioAlmacenes).where(eq(operarioAlmacenes.operarioId, operarioId))
  if (almacenIds.length > 0) {
    await db.insert(operarioAlmacenes).values(almacenIds.map((almacenId) => ({ operarioId, almacenId })))
  }
}
