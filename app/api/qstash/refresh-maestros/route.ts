import { NextRequest, NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/queue/verify'
import { refreshMaestros } from '@/lib/maestros/refresh'
import { registrarAuditoria } from '@/lib/audit'

// Four reads against Odoo (almacenes, couriers, barcos and courier usage), spaced
// 1 s apart by odooCall and queued with the session syncs on the same
// parallelism:1 queue. Five minutes of room for a slow Odoo, the same ceiling as
// the session sync.
export const maxDuration = 300

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text()
  const signature = request.headers.get('upstash-signature') ?? ''
  if (!(await verifyQstashSignature(signature, body))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  try {
    const resumen = await refreshMaestros()
    await registrarAuditoria({ operarioId: null, accion: 'admin_refresco', detalle: { ...resumen } })
    return NextResponse.json({ ok: true, ...resumen })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
