'use server'

import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { publishRefreshMaestros, publishRefreshTrackings } from '@/lib/queue/publish'

/** Enqueues an on-demand refresh of the Odoo masters and of the tracking cache onto the odoo-sync queue. */
export async function refreshBarcosAction(): Promise<void> {
  await requireAdminFromCookies()
  await publishRefreshMaestros()
  await publishRefreshTrackings()
}
