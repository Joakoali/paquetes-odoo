// lib/sync/pendientes.ts
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client'
import {
  sesionesEscaneo, sesionCourierBatches, sesionItems, type SesionEscaneo,
} from '../../db/schema'
import { publishSync } from '../queue/publish'

export async function listSessionsInError(): Promise<SesionEscaneo[]> {
  return db.query.sesionesEscaneo.findMany({ where: eq(sesionesEscaneo.estado, 'error') })
}

/**
 * Sessions that synced fine but left at least one package behind: the tracking
 * number was already live in Odoo, so the item was dropped from the picking.
 * The physical package exists and is in no picking — somebody has to look.
 */
export async function listSessionsWithDuplicates(): Promise<SesionEscaneo[]> {
  const rows = await db.select({ sesion: sesionesEscaneo })
    .from(sesionesEscaneo)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.sesionId, sesionesEscaneo.id))
    .innerJoin(sesionItems, eq(sesionItems.courierBatchId, sesionCourierBatches.id))
    .where(and(
      eq(sesionesEscaneo.estado, 'sincronizada'),
      eq(sesionItems.estado, 'duplicado'),
    ))
    .groupBy(sesionesEscaneo.id)

  return rows.map((r) => r.sesion)
}

export async function retrySession(sesionId: string): Promise<void> {
  await publishSync({ sesionId })
}
