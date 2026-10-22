import { NextRequest, NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/queue/verify'
import { refreshTrackingActivos } from '@/lib/cache/trackingActivos'
import { registrarAuditoria } from '@/lib/audit'

// The cache is rebuilt from pages of 2000 move lines, one Odoo request per second,
// and the job waits its turn on the same parallelism:1 queue as the session syncs.
export const maxDuration = 300

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text()
  const signature = request.headers.get('upstash-signature') ?? ''
  if (!(await verifyQstashSignature(signature, body))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  try {
    const resumen = await refreshTrackingActivos()
    await registrarAuditoria({ operarioId: null, accion: 'admin_refresco', detalle: { ...resumen } })
    return NextResponse.json({ ok: true, ...resumen })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
