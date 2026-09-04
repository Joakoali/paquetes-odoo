import { NextRequest, NextResponse } from 'next/server'
import { publishRefreshBarcos } from '@/lib/queue/publish'

// Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`. The route
// does no Odoo work itself — it only enqueues the refresh job onto the
// odoo-sync queue so the worker stays the sole caller of Odoo.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  await publishRefreshBarcos()
  return NextResponse.json({ ok: true })
}
