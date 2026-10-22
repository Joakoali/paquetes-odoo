import { NextRequest, NextResponse } from 'next/server'
import { publishRefreshMaestros, publishRefreshTrackings } from '@/lib/queue/publish'

// Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`. The route
// does no Odoo work itself — it only enqueues the refresh jobs (the Odoo masters
// and the tracking cache) onto the odoo-sync queue so the worker stays the sole
// caller of Odoo.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  await publishRefreshMaestros()
  await publishRefreshTrackings()
  return NextResponse.json({ ok: true })
}
