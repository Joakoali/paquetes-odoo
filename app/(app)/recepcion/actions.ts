'use server'

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  sesionesEscaneo, sesionCourierBatches, sesionItems,
  type SesionEscaneo, type SesionCourierBatch,
} from '@/db/schema'
import { ForbiddenError } from '@/lib/auth/guards'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import { isKnownDuplicate } from '@/lib/cache/trackingActivos'
import { publishSync } from '@/lib/queue/publish'

/** Loads a session and asserts it belongs to the caller. */
async function ownedSesion(sesionId: string, operarioId: string): Promise<SesionEscaneo> {
  const sesion = await db.query.sesionesEscaneo.findFirst({
    where: (s, { eq: e }) => e(s.id, sesionId),
  })
  if (!sesion || sesion.operarioId !== operarioId) {
    throw new ForbiddenError(`Sesión ${sesionId} no pertenece al operario`)
  }
  return sesion
}

/** Loads a courier batch + its session and asserts the session belongs to the caller. */
async function ownedBatch(
  batchId: string,
  operarioId: string,
): Promise<{ batch: SesionCourierBatch; sesion: SesionEscaneo }> {
  const batch = await db.query.sesionCourierBatches.findFirst({
    where: (b, { eq: e }) => e(b.id, batchId),
  })
  if (!batch) throw new ForbiddenError(`Batch ${batchId} no existe`)
  const sesion = await ownedSesion(batch.sesionId, operarioId)
  return { batch, sesion }
}

export async function startSession(almacenId: number, barcoOdooId: number): Promise<string> {
  const operario = await requireOperarioFromCookies()
  if (!(await operarioHasAlmacen(operario.id, almacenId))) {
    throw new ForbiddenError(`Operario sin acceso al almacén ${almacenId}`)
  }
  const [row] = await db.insert(sesionesEscaneo).values({
    operarioId: operario.id, almacenId, barcoOdooId, tipo: 'recepcion',
  }).returning()
  return row.id
}

export async function startCourierBatch(sesionId: string, courierId: number): Promise<string> {
  const operario = await requireOperarioFromCookies()
  await ownedSesion(sesionId, operario.id)
  const [row] = await db.insert(sesionCourierBatches).values({ sesionId, courierId }).returning()
  return row.id
}

export async function scanTracking(
  batchId: string,
  trackingNumber: string,
): Promise<{ estado: 'ok' | 'duplicado' }> {
  const operario = await requireOperarioFromCookies()
  const { sesion } = await ownedBatch(batchId, operario.id)

  // Spec §4.1: duplicate detection is scoped to everything already scanned in
  // THIS session, not just the current courier batch — the same tracking under
  // DHL and then GLS is still the same physical package.
  const sesionBatchIds = (await db.query.sesionCourierBatches.findMany({
    where: (b, { eq: e }) => e(b.sesionId, sesion.id),
  })).map((b) => b.id)

  const alreadyInSession = await db.query.sesionItems.findFirst({
    where: (i, { and, eq: e, inArray }) => and(
      inArray(i.courierBatchId, sesionBatchIds),
      e(i.trackingNumber, trackingNumber),
    ),
  })
  // A re-scan is not new work: report it and insert nothing (a second row would
  // also violate the (courier_batch_id, tracking_number) unique constraint).
  if (alreadyInSession) return { estado: 'duplicado' }

  const estado = (await isKnownDuplicate(trackingNumber)) ? 'duplicado' : 'ok'
  await db.insert(sesionItems).values({ courierBatchId: batchId, trackingNumber, estado }).returning()
  return { estado }
}

export async function finishCourierBatch(batchId: string): Promise<void> {
  const operario = await requireOperarioFromCookies()
  await ownedBatch(batchId, operario.id)
  // No state change needed today — batches are implicitly closed by starting
  // a new one or confirming the session. Kept as an explicit action so the
  // UI has a clear point to move focus back to the courier selector.
}

export async function confirmSession(sesionId: string): Promise<void> {
  const operario = await requireOperarioFromCookies()
  const sesion = await ownedSesion(sesionId, operario.id)

  // Already confirmed (or already synced): do not re-publish to the queue.
  if (sesion.estado === 'confirmada_pendiente_sync' || sesion.estado === 'sincronizada') return

  await db.update(sesionesEscaneo).set({
    estado: 'confirmada_pendiente_sync',
    confirmedAt: new Date(),
  }).where(eq(sesionesEscaneo.id, sesionId))

  await publishSync({ sesionId })
}
