import { cache } from 'react'
import { and, eq, gte } from 'drizzle-orm'
import { db } from '../../db/client'
import { sesionesAuth, operarios, type Operario } from '../../db/schema'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours

export async function createSession(operarioId: string): Promise<string> {
  const [row] = await db.insert(sesionesAuth).values({
    operarioId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  }).returning()
  return row.id
}

/**
 * The operario of the session, while it has not expired and the operario is active; null otherwise. One query for
 * both, and one per render: the layout and the page ask for it in the same render, and `cache` gives both the same
 * answer.
 */
export const getSessionOperario = cache(async (token: string): Promise<Operario | null> => {
  const [fila] = await db.select({ operario: operarios })
    .from(sesionesAuth)
    .innerJoin(operarios, eq(operarios.id, sesionesAuth.operarioId))
    .where(and(eq(sesionesAuth.id, token), gte(sesionesAuth.expiresAt, new Date()), eq(operarios.activo, true)))
  return fila?.operario ?? null
})

export async function destroySession(token: string): Promise<void> {
  await db.delete(sesionesAuth).where(eq(sesionesAuth.id, token))
}
