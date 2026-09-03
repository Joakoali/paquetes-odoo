'use server'

import { and, eq } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { db } from '@/db/client'
import { sesionesEscaneo, sesionCourierBatches, sesionItems } from '@/db/schema'
import { requireOperario } from '@/lib/auth/guards'
import { isKnownDuplicate } from '@/lib/cache/trackingActivos'
import { publishSync } from '@/lib/queue/publish'

async function currentOperarioId(): Promise<string> {
  const store = await cookies()
  const token = store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value
  const operario = await requireOperario(token)
  return operario.id
}

export async function startSession(almacenId: number, barcoOdooId: number): Promise<string> {
  const operarioId = await currentOperarioId()
  const [row] = await db.insert(sesionesEscaneo).values({
    operarioId, almacenId, barcoOdooId, tipo: 'recepcion',
  }).returning()
  return row.id
}

export async function startCourierBatch(sesionId: string, courierId: number): Promise<string> {
  const [row] = await db.insert(sesionCourierBatches).values({ sesionId, courierId }).returning()
  return row.id
}

export async function scanTracking(
  batchId: string,
  trackingNumber: string,
): Promise<{ estado: 'ok' | 'duplicado' }> {
  const alreadyInBatch = await db.query.sesionItems.findFirst({
    where: and(eq(sesionItems.courierBatchId, batchId), eq(sesionItems.trackingNumber, trackingNumber)),
  })
  const duplicate = Boolean(alreadyInBatch) || (await isKnownDuplicate(trackingNumber))
  const estado = duplicate ? 'duplicado' : 'ok'

  await db.insert(sesionItems).values({ courierBatchId: batchId, trackingNumber, estado })
  return { estado }
}

export async function finishCourierBatch(_batchId: string): Promise<void> {
  // No state change needed today — batches are implicitly closed by starting
  // a new one or confirming the session. Kept as an explicit action so the
  // UI has a clear point to move focus back to the courier selector.
}

export async function confirmSession(sesionId: string): Promise<void> {
  await db.update(sesionesEscaneo).set({
    estado: 'confirmada_pendiente_sync',
    confirmedAt: new Date(),
  }).where(eq(sesionesEscaneo.id, sesionId))

  await publishSync({ sesionId })
}
