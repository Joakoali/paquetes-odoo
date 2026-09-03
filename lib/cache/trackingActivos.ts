import { eq, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { trackingActivosCache } from '../../db/schema'

export async function isKnownDuplicate(trackingNumber: string): Promise<boolean> {
  const row = await db.query.trackingActivosCache.findFirst({
    where: eq(trackingActivosCache.trackingNumber, trackingNumber),
  })
  return row !== undefined
}

export async function recordSyncedTracking(trackingNumber: string, odooPickingId: number): Promise<void> {
  await db.insert(trackingActivosCache)
    .values({ trackingNumber, odooPickingId })
    .onConflictDoUpdate({
      target: trackingActivosCache.trackingNumber,
      set: { odooPickingId, updatedAt: new Date() },
    })
}

/**
 * Bulk variant: one multi-row upsert instead of one neon-http round trip per
 * package. `excluded.*` is the row that was proposed for insertion, so each
 * conflicting row keeps its own picking id.
 */
export async function recordSyncedTrackings(
  pairs: Array<{ trackingNumber: string; odooPickingId: number }>,
): Promise<void> {
  if (pairs.length === 0) return
  await db.insert(trackingActivosCache)
    .values(pairs)
    .onConflictDoUpdate({
      target: trackingActivosCache.trackingNumber,
      set: { odooPickingId: sql`excluded.odoo_picking_id`, updatedAt: new Date() },
    })
}
