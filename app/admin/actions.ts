'use server'

import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { publishRefreshBarcos } from '@/lib/queue/publish'

/** Enqueues an on-demand barcos-cache refresh onto the odoo-sync queue. */
export async function refreshBarcosAction(): Promise<void> {
  await requireAdminFromCookies()
  await publishRefreshBarcos()
}
