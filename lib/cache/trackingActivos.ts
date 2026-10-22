import { eq, lt, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { trackingActivosCache } from '../../db/schema'
import { fetchLineasConTracking, type LineaTrackingOdoo } from '../odoo/maestros'

/** How many move lines each request to Odoo asks for while the cache is rebuilt. */
export const PAGINA_TRACKINGS = 2000

/** Rows per upsert while the cache is rebuilt. */
const TANDA_ESCRITURA = 1000

/**
 * Where Odoo already has this tracking number, according to the cache; null when the cache
 * does not know it. A row that has no reference (the ones the sync wrote before it kept the
 * reference) is named by its picking id.
 */
export async function buscarDuplicado(trackingNumber: string): Promise<{ odooPickingRef: string } | null> {
  const fila = await db.query.trackingActivosCache.findFirst({
    where: eq(trackingActivosCache.trackingNumber, trackingNumber),
  })
  if (!fila) return null
  return { odooPickingRef: fila.odooPickingRef || `picking #${fila.odooPickingId}` }
}

/**
 * One multi-row upsert instead of one neon-http round trip per package. `excluded.*` is the
 * row that was proposed for insertion, so each conflicting row takes its own picking and its
 * own reference (none, when none is given): a tracking never keeps the reference of the
 * picking it left. Every row is stamped with the app's clock, the same one `inicio` comes
 * from in `refreshTrackingActivos`, so the sweep compares like with like.
 */
export async function recordSyncedTrackings(
  filas: Array<{ trackingNumber: string; odooPickingId: number; odooPickingRef?: string | null }>,
): Promise<void> {
  if (filas.length === 0) return
  const ahora = new Date()
  await db.insert(trackingActivosCache)
    .values(filas.map((fila) => ({
      trackingNumber: fila.trackingNumber,
      odooPickingId: fila.odooPickingId,
      odooPickingRef: fila.odooPickingRef ?? null,
      updatedAt: ahora,
    })))
    .onConflictDoUpdate({
      target: trackingActivosCache.trackingNumber,
      set: {
        odooPickingId: sql`excluded.odoo_picking_id`,
        odooPickingRef: sql`excluded.odoo_picking_ref`,
        updatedAt: ahora,
      },
    })
}

/**
 * Rebuilds the cache from Odoo: every tracking number on a move line that has not been
 * cancelled, with the picking it is in. Mark and sweep, so the cache is never empty halfway
 * and a failing Odoo read leaves it as it was:
 *
 * 1. `inicio` is noted before Odoo is read.
 * 2. All the pages are read (`odooCall` spaces the requests 1 s apart) and only then is
 *    anything written. If Odoo sent no line at all, nothing is written or deleted and `filas`
 *    is 0: an empty answer is more likely a failed or filtered read than "Odoo has none", and
 *    the sweep would empty the cache (`refreshMaestros` follows the same rule).
 * 3. Every tracking Odoo has is upserted, which stamps it with a time that is not before `inicio`.
 * 4. What still carries an older time is no longer in Odoo (its picking was cancelled) and is
 *    deleted. A row a sync wrote while this ran is newer than `inicio`, so it stays even
 *    though the pages were read before that picking existed.
 */
export async function refreshTrackingActivos(): Promise<{ filas: number }> {
  const inicio = new Date()

  const porTracking = new Map<string, LineaTrackingOdoo>()
  for (let offset = 0; ; offset += PAGINA_TRACKINGS) {
    const pagina = await fetchLineasConTracking({ offset, limit: PAGINA_TRACKINGS })
    for (const linea of pagina) {
      const actual = porTracking.get(linea.trackingNumber)
      // A tracking that is in a reception and in the delivery that took it out is "in" the
      // reception. Between two lines of the same kind, the first one stays.
      if (!actual || (linea.esRecepcion && !actual.esRecepcion)) porTracking.set(linea.trackingNumber, linea)
    }
    if (pagina.length < PAGINA_TRACKINGS) break
  }
  if (porTracking.size === 0) return { filas: 0 }

  const filas = [...porTracking.values()].map((linea) => ({
    trackingNumber: linea.trackingNumber,
    odooPickingId: linea.pickingId,
    odooPickingRef: linea.pickingRef,
  }))
  for (let desde = 0; desde < filas.length; desde += TANDA_ESCRITURA) {
    await recordSyncedTrackings(filas.slice(desde, desde + TANDA_ESCRITURA))
  }

  await db.delete(trackingActivosCache).where(lt(trackingActivosCache.updatedAt, inicio))
  return { filas: filas.length }
}
