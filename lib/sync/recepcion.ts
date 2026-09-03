import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client'
import { sesionesEscaneo, sesionCourierBatches, sesionItems } from '../../db/schema'
import {
  checkDuplicateTrackingNumbers,
  createIncomingPicking,
  addCourierMoveWithLines,
  validatePicking,
} from '../odoo/pickings'
import { callKw } from '../odoo/client'
import { recordSyncedTrackings } from '../cache/trackingActivos'

const TODOS_DUPLICADOS =
  'Todos los tracking numbers eran duplicados — no se creó ningún movimiento'

/**
 * THE single place recepción data is pushed to Odoo. Called by the QStash
 * single-consumer worker, one session at a time. Idempotent: safe to retry
 * after a partial failure — an already-created picking is reused and any
 * courier batch that already has an odoo_move_id is skipped.
 */
export async function syncRecepcionSession(sesionId: string): Promise<void> {
  const sesion = await db.query.sesionesEscaneo.findFirst({
    where: (s, { eq: e }) => e(s.id, sesionId),
  })
  if (!sesion) throw new Error(`Sesión ${sesionId} no encontrada`)

  // QStash may re-deliver a job whose previous run already fully succeeded.
  if (sesion.estado === 'sincronizada') return

  const almacen = await db.query.almacenes.findFirst({
    where: (a, { eq: e }) => e(a.id, sesion.almacenId),
  })
  if (!almacen?.odooPickingTypeId) {
    throw new Error(`Almacén ${sesion.almacenId} no tiene odoo_picking_type_id configurado`)
  }

  const batches = await db.query.sesionCourierBatches.findMany({
    where: (b, { eq: e }) => e(b.sesionId, sesionId),
  })
  const pendingBatches = batches.filter((b) => !b.odooMoveId)

  // Items already flagged `duplicado` at scan time must never reach Odoo.
  const trackingByBatch = new Map<string, string[]>()
  for (const batch of pendingBatches) {
    const items = await db.query.sesionItems.findMany({
      where: (i, { and: a, eq: e, ne }) => a(e(i.courierBatchId, batch.id), ne(i.estado, 'duplicado')),
    })
    trackingByBatch.set(batch.id, items.map((i) => i.trackingNumber))
  }

  // Spec §4.1: ONE live duplicate check for the whole session, not one per
  // courier batch. A tracking number found here is marked 'duplicado' locally
  // and excluded from its courier's move-line batch — one bad tracking number
  // must not block the legitimate packages.
  const allTracking = [...new Set([...trackingByBatch.values()].flat())]
  const liveDuplicates = new Set(await checkDuplicateTrackingNumbers(allTracking))

  let pickingId = sesion.odooPickingId
  if (!pickingId) {
    pickingId = await createIncomingPicking(almacen.odooPickingTypeId, sesion.barcoOdooId)
    await db.update(sesionesEscaneo)
      .set({ odooPickingId: pickingId })
      .where(eq(sesionesEscaneo.id, sesionId))
  }

  // A previous attempt may already have created moves for some batches.
  let anyMove = batches.some((b) => b.odooMoveId !== null && b.odooMoveId !== undefined)

  for (const batch of pendingBatches) {
    const courier = await db.query.couriers.findFirst({
      where: (c, { eq: e }) => e(c.id, batch.courierId),
    })
    if (!courier?.odooProductId) {
      throw new Error(`Courier ${batch.courierId} no tiene odoo_product_id configurado`)
    }

    const trackingNumbers = trackingByBatch.get(batch.id) ?? []
    const dupes = trackingNumbers.filter((t) => liveDuplicates.has(t))
    const toSync = trackingNumbers.filter((t) => !liveDuplicates.has(t))

    if (dupes.length > 0) {
      await db.update(sesionItems)
        .set({ estado: 'duplicado' })
        .where(and(
          eq(sesionItems.courierBatchId, batch.id),
          inArray(sesionItems.trackingNumber, dupes),
        ))
    }

    if (toSync.length > 0) {
      const moveId = await addCourierMoveWithLines(pickingId, courier.odooProductId, toSync)
      await db.update(sesionCourierBatches)
        .set({ odooMoveId: moveId })
        .where(eq(sesionCourierBatches.id, batch.id))
      // One UPDATE and one multi-row upsert per batch instead of two neon-http
      // round trips per package — a 30-package session stays well inside the
      // function timeout.
      await db.update(sesionItems)
        .set({ estado: 'sincronizado' })
        .where(and(
          eq(sesionItems.courierBatchId, batch.id),
          inArray(sesionItems.trackingNumber, toSync),
        ))
      await recordSyncedTrackings(toSync.map((trackingNumber) => ({
        trackingNumber, odooPickingId: pickingId as number,
      })))
      anyMove = true
    }
  }

  // Every tracking number turned out to be a duplicate: the picking has no
  // moves, and validating a move-less picking is an Odoo UserError that would
  // fail every retry forever. Close the session instead and leave a note so
  // /pendientes surfaces it for a human.
  if (anyMove) {
    // On a retry the picking may already have been validated (or cancelled) by
    // a previous run — re-validating a terminal picking would error, so skip it.
    const [cur] = await callKw<Array<{ state: string }>>(
      'stock.picking', 'read', [[pickingId], ['state']],
    )
    if (!cur) throw new Error(`picking ${pickingId} no existe en Odoo`)
    if (cur.state !== 'done' && cur.state !== 'cancel') {
      await validatePicking(pickingId)
    }
  }

  const recibidoPorField = process.env.ODOO_FIELD_RECIBIDO_POR
  await callKw('stock.picking', 'message_post', [[pickingId]], {
    body: `Registrado vía Webapp Paquetería por operario ${sesion.operarioId}`,
  })
  if (recibidoPorField) {
    await callKw('stock.picking', 'write', [[pickingId], { [recibidoPorField]: sesion.operarioId }])
  }

  await db.update(sesionesEscaneo)
    .set({
      estado: 'sincronizada',
      syncedAt: new Date(),
      // Only a session that actually HAD packages, all of them duplicates,
      // gets the note. An empty session just finishes quietly.
      ultimoError: !anyMove && allTracking.length > 0 ? TODOS_DUPLICADOS : null,
    })
    .where(eq(sesionesEscaneo.id, sesionId))
}
