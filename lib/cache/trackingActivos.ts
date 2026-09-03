import { eq } from 'drizzle-orm'
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
