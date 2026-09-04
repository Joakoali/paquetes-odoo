import { NextRequest, NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/queue/verify'
import { refreshBarcosCache } from '@/lib/cache/barcos'

// One `project.project/search_read` against Odoo, throttled alongside the
// session syncs on the same parallelism:1 queue.
export const maxDuration = 60

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text()
  const signature = request.headers.get('upstash-signature') ?? ''
  if (!(await verifyQstashSignature(signature, body))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  try {
    await refreshBarcosCache()
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
