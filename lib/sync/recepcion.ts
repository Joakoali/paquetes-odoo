import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { sesionesEscaneo, sesionCourierBatches, sesionItems } from '../../db/schema'
import {
  checkDuplicateTrackingNumbers,
  createIncomingPicking,
  addCourierMoveWithLines,
  validatePicking,
} from '../odoo/pickings'
import { callKw } from '../odoo/client'
import { recordSyncedTracking } from '../cache/trackingActivos'

/**
 * THE single place recepción data is pushed to Odoo. Called by the QStash
 * single-consumer worker, one session at a time. Idempotent: safe to retry
 * after a partial failure — an already-created picking is reused and any
 * courier batch that already has an odoo_move_id is skipped.
 */
export async function syncRecepcionSession(sesionId: string): Promise<void> {
  const sesion = await db.query.sesionesEscaneo.findFirst({
    where: (s, { eq }) => eq(s.id, sesionId),
  })
  if (!sesion) throw new Error(`Sesión ${sesionId} no encontrada`)

  // QStash may re-deliver a job whose previous run already fully succeeded.
  if (sesion.estado === 'sincronizada') return

  const almacen = await db.query.almacenes.findFirst({
    where: (a, { eq }) => eq(a.id, sesion.almacenId),
  })
  if (!almacen?.odooPickingTypeId) {
    throw new Error(`Almacén ${sesion.almacenId} no tiene odoo_picking_type_id configurado`)
  }

  const batches = await db.query.sesionCourierBatches.findMany({
    where: (b, { eq }) => eq(b.sesionId, sesionId),
  })

  let pickingId = sesion.odooPickingId
  if (!pickingId) {
    pickingId = await createIncomingPicking(almacen.odooPickingTypeId, sesion.barcoOdooId)
    await db.update(sesionesEscaneo)
      .set({ odooPickingId: pickingId })
      .where(eq(sesionesEscaneo.id, sesionId))
  }

  for (const batch of batches) {
    if (batch.odooMoveId) continue // already synced on a previous attempt

    const courier = await db.query.couriers.findFirst({
      where: (c, { eq }) => eq(c.id, batch.courierId),
    })
    if (!courier?.odooProductId) {
      throw new Error(`Courier ${batch.courierId} no tiene odoo_product_id configurado`)
    }

    const items = await db.query.sesionItems.findMany({
      where: (i, { eq }) => eq(i.courierBatchId, batch.id),
    })
    const trackingNumbers = items.map((i) => i.trackingNumber)

    // Final safety check against live Odoo data. A tracking number found here is
    // marked 'duplicado' locally and excluded from this courier's move-line
    // batch — one bad tracking number must not block the legitimate packages.
    const liveDuplicates = await checkDuplicateTrackingNumbers(trackingNumbers)
    const toSync = trackingNumbers.filter((t) => !liveDuplicates.includes(t))

    for (const tracking of liveDuplicates) {
      await db.update(sesionItems)
        .set({ estado: 'duplicado' })
        .where(and(
          eq(sesionItems.courierBatchId, batch.id),
          eq(sesionItems.trackingNumber, tracking),
        ))
    }

    if (toSync.length > 0) {
      const moveId = await addCourierMoveWithLines(pickingId, courier.odooProductId, toSync)
      await db.update(sesionCourierBatches)
        .set({ odooMoveId: moveId })
        .where(eq(sesionCourierBatches.id, batch.id))
      for (const tracking of toSync) {
        await db.update(sesionItems)
          .set({ estado: 'sincronizado' })
          .where(and(
            eq(sesionItems.courierBatchId, batch.id),
            eq(sesionItems.trackingNumber, tracking),
          ))
        await recordSyncedTracking(tracking, pickingId)
      }
    }
  }

  // On a retry the picking may already have been validated (or cancelled) by a
  // previous run — re-validating a terminal picking would error, so skip it.
  const [cur] = await callKw<Array<{ state: string }>>(
    'stock.picking', 'read', [[pickingId], ['state']],
  )
  if (cur.state !== 'done' && cur.state !== 'cancel') {
    await validatePicking(pickingId)
  }

  const recibidoPorField = process.env.ODOO_FIELD_RECIBIDO_POR
  await callKw('stock.picking', 'message_post', [[pickingId]], {
    body: `Registrado vía Webapp Paquetería por operario ${sesion.operarioId}`,
  })
  if (recibidoPorField) {
    await callKw('stock.picking', 'write', [[pickingId], { [recibidoPorField]: sesion.operarioId }])
  }

  await db.update(sesionesEscaneo)
    .set({ estado: 'sincronizada', syncedAt: new Date() })
    .where(eq(sesionesEscaneo.id, sesionId))
}
