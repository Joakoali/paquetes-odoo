import { eq } from 'drizzle-orm'
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

export async function getSessionOperario(token: string): Promise<Operario | null> {
  const session = await db.query.sesionesAuth.findFirst({
    where: eq(sesionesAuth.id, token),
  })
  if (!session || session.expiresAt < new Date()) return null

  const operario = await db.query.operarios.findFirst({
    where: eq(operarios.id, session.operarioId),
  })
  if (!operario || !operario.activo) return null
  return operario
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sesionesAuth).where(eq(sesionesAuth.id, token))
}
