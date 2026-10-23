import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../../db/client'
import {
  operarios, sesionesEscaneo, sesionCourierBatches, sesionItems,
  type SesionCourierBatch, type SesionEscaneo,
} from '../../db/schema'
import {
  checkDuplicateTrackingNumbers,
  createIncomingPicking,
  addCourierMoveWithLines,
  validatePicking,
} from '../odoo/pickings'
import { odooCall } from '../odoo/client'
import { recordSyncedTrackings } from '../cache/trackingActivos'
import { registrarAuditoria } from '../audit'
import { ConfiguracionError } from '../errores'

const TODOS_DUPLICADOS =
  'Todos los tracking numbers eran duplicados — no se creó ningún movimiento'

/**
 * Who scanned the packages that are in the picking, for "Recibido por" and the chatter note: each name
 * once, in the order of the first scan, separated by commas. A package from before the webapp kept who
 * scanned it (no operario) counts for the operario who opened the recepción, who is also the one named
 * when no package went in the picking. Whoever scanned only packages that were left out as duplicates is
 * not named: they received nothing in this picking.
 */
async function scannerNames(sesion: SesionEscaneo): Promise<string> {
  const [scans, [opener]] = await Promise.all([
    db.select({ nombre: operarios.nombre })
      .from(sesionItems)
      .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.id, sesionItems.courierBatchId))
      .leftJoin(operarios, eq(operarios.id, sesionItems.operarioId))
      .where(and(eq(sesionCourierBatches.sesionId, sesion.id), ne(sesionItems.estado, 'duplicado')))
      .orderBy(asc(sesionItems.createdAt), asc(sesionItems.id)),
    db.select({ nombre: operarios.nombre }).from(operarios).where(eq(operarios.id, sesion.operarioId)),
  ])
  const names = new Set(scans.map((scan) => scan.nombre ?? opener.nombre))
  return names.size > 0 ? [...names].join(', ') : opener.nombre
}

/**
 * THE single place recepción data is pushed to Odoo. Called by the QStash
 * single-consumer worker, one session at a time. Idempotent: safe to retry
 * after a partial failure — an already-created picking is reused and any
 * courier batch that already has an odoo_move_id is skipped. It only acts
 * on a recepción that is `confirmada_pendiente_sync`; for any other it
 * returns without calling Odoo or changing anything.
 */
export async function syncRecepcionSession(sesionId: string): Promise<void> {
  const sesion = await db.query.sesionesEscaneo.findFirst({
    where: (s, { eq: e }) => e(s.id, sesionId),
  })
  if (!sesion) throw new Error(`Sesión ${sesionId} no encontrada`)

  // Only a recepción that was sent and is waiting for its sync is the worker's to touch. A message can still
  // arrive for any other: QStash re-delivering a run that already finished (`sincronizada`); a recepción that
  // went back to the operarios because publishing failed (`en_curso`), although the message got through; one
  // that failed for good (`error`), which Pendientes' "Reintentar" puts back to `confirmada_pendiente_sync`
  // before queuing it again. None of them may be synced, nor fail here: a failure would send a recepción that
  // is still open to `error`.
  if (sesion.estado !== 'confirmada_pendiente_sync') return

  const almacen = await db.query.almacenes.findFirst({
    where: (a, { eq: e }) => e(a.id, sesion.almacenId),
  })
  if (!almacen?.odooInTypeId) {
    throw new ConfiguracionError('El almacén no tiene tipo de recepción. Refrescá los datos de Odoo.')
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
      orderBy: (i, ops) => [ops.asc(i.createdAt), ops.asc(i.id)],
    })
    trackingByBatch.set(batch.id, items.map((i) => i.trackingNumber))
  }

  // Every move needs the Odoo product of its courier. Found out now, before anything is made in Odoo, so that
  // a courier without one (something an admin has to fix) leaves no half-made picking behind. A batch with
  // nothing to send needs none.
  const batchesToSend: Array<{ batch: SesionCourierBatch; productId: number }> = []
  for (const batch of pendingBatches) {
    if ((trackingByBatch.get(batch.id) ?? []).length === 0) continue
    const courier = await db.query.couriers.findFirst({
      where: (c, { eq: e }) => e(c.id, batch.courierId),
    })
    if (!courier?.odooProductId) {
      throw new ConfiguracionError(`El courier ${courier?.nombre ?? batch.courierId} no tiene producto en Odoo.`)
    }
    batchesToSend.push({ batch, productId: courier.odooProductId })
  }

  // Spec §4.1: ONE live duplicate check for the whole session, not one per
  // courier batch. A tracking number found here is marked 'duplicado' locally
  // and excluded from its courier's move-line batch — one bad tracking number
  // must not block the legitimate packages.
  const allTracking = [...new Set([...trackingByBatch.values()].flat())]
  const liveDuplicates = await checkDuplicateTrackingNumbers(allTracking)

  let pickingId = sesion.odooPickingId
  if (!pickingId) {
    pickingId = await createIncomingPicking(almacen.odooInTypeId, sesion.barcoOdooId)
    await db.update(sesionesEscaneo)
      .set({ odooPickingId: pickingId })
      .where(eq(sesionesEscaneo.id, sesionId))
  }

  // A previous attempt may already have created moves for some batches.
  let anyMove = batches.some((b) => b.odooMoveId !== null && b.odooMoveId !== undefined)

  // stock.move's location_id/location_dest_id are NOT derived from picking_id by
  // a raw ORM create() — only the UI's onchange fills them. Read the picking's own
  // locations once and pass them explicitly to every move created below. The same
  // read brings the picking's name (MB92/IN/00231), kept on the session right away
  // so that even a sync that fails later can say which picking it left behind.
  const [picking] = await odooCall<Array<{
    name: string
    location_id: [number, string]
    location_dest_id: [number, string]
  }>>('stock.picking', 'read', { ids: [pickingId], fields: ['location_id', 'location_dest_id', 'name'] })
  if (!picking) throw new Error(`picking ${pickingId} no existe en Odoo`)
  const locationId = picking.location_id[0]
  const locationDestId = picking.location_dest_id[0]
  const pickingRef = picking.name
  await db.update(sesionesEscaneo)
    .set({ odooPickingRef: pickingRef })
    .where(eq(sesionesEscaneo.id, sesionId))

  for (const { batch, productId } of batchesToSend) {
    const trackingNumbers = trackingByBatch.get(batch.id) ?? []
    const dupes = trackingNumbers.filter((t) => liveDuplicates.has(t))
    const toSync = trackingNumbers.filter((t) => !liveDuplicates.has(t))

    // Found while sending: kept in the recepción, flagged, and pointing to the picking that has them.
    for (const trackingNumber of dupes) {
      await db.update(sesionItems)
        .set({
          estado: 'duplicado',
          duplicadoAlEnviar: true,
          duplicadoRef: liveDuplicates.get(trackingNumber),
        })
        .where(and(
          eq(sesionItems.courierBatchId, batch.id),
          eq(sesionItems.trackingNumber, trackingNumber),
        ))
    }

    if (toSync.length > 0) {
      const moveId = await addCourierMoveWithLines(
        pickingId, productId, toSync, locationId, locationDestId,
      )
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
        trackingNumber, odooPickingId: pickingId as number, odooPickingRef: pickingRef,
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
    const [cur] = await odooCall<Array<{ state: string }>>(
      'stock.picking', 'read', { ids: [pickingId], fields: ['state'] },
    )
    if (!cur) throw new Error(`picking ${pickingId} no existe en Odoo`)
    if (cur.state !== 'done' && cur.state !== 'cancel') {
      await validatePicking(pickingId)
    }
  }

  const names = await scannerNames(sesion)
  const recibidoPorField = process.env.ODOO_FIELD_RECIBIDO_POR
  await odooCall('stock.picking', 'message_post', {
    ids: [pickingId],
    body: `Registrado vía Webapp Paquetería por ${names}`,
  })
  if (recibidoPorField) {
    await odooCall('stock.picking', 'write', {
      ids: [pickingId],
      vals: { [recibidoPorField]: names },
    })
  }

  await db.update(sesionesEscaneo)
    .set({
      estado: 'sincronizada',
      syncedAt: new Date(),
      // Only a session that actually HAD packages, all of them duplicates,
      // gets the note. An empty session just finishes quietly.
      ultimoError: !anyMove && allTracking.length > 0 ? TODOS_DUPLICADOS : null,
      // A failure an earlier attempt left behind (one QStash then retried) is over.
      ultimoErrorTipo: null,
    })
    .where(eq(sesionesEscaneo.id, sesionId))

  await registrarAuditoria({
    operarioId: null,
    accion: 'sync_ok',
    detalle: { sesionId, odooPickingRef: pickingRef },
  })
}
