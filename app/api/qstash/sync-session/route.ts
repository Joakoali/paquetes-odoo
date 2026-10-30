import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { verifyQstashSignature } from '@/lib/queue/verify'
import { db } from '@/db/client'
import { sesionesEscaneo } from '@/db/schema'
import type { SesionEscaneo } from '@/db/schema'
import { syncRecepcionSession } from '@/lib/sync/recepcion'
import { syncEntregaSession } from '@/lib/sync/entrega'
import { syncReasignacionSession } from '@/lib/sync/reasignacion'
import { registrarFalloSync } from '@/lib/sync/estado'

/** The worker of each kind of session: a new kind does not compile until it has one. */
const WORKERS: Record<SesionEscaneo['tipo'], (sesionId: string) => Promise<void>> = {
  recepcion: syncRecepcionSession,
  entrega: syncEntregaSession,
  reasignacion: syncReasignacionSession,
}

// A session can hold dozens of packages, each an Odoo round trip throttled to
// ~1 req/s — well past Vercel's default function timeout.
export const maxDuration = 300

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text()
  const signature = request.headers.get('upstash-signature') ?? ''
  if (!(await verifyQstashSignature(signature, body))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  let sesionId: string
  try {
    ;({ sesionId } = JSON.parse(body) as { sesionId: string })
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const sesion = await db.query.sesionesEscaneo.findFirst({ where: eq(sesionesEscaneo.id, sesionId) })
  if (!sesion) return NextResponse.json({ error: 'sesion not found' }, { status: 404 })

  try {
    await WORKERS[sesion.tipo](sesionId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    // How many times QStash has already redelivered this message: 0 on the first delivery.
    const reintentosHechos = Number(request.headers.get('upstash-retried') ?? 0)
    const { final, tipo } = await registrarFalloSync({ sesionId, error: err, reintentosHechos })
    const message = err instanceof Error ? err.message : String(err)

    // A failure that will not get better (or has used up its retries) answers 200 on purpose:
    // QStash takes the message as delivered and the queue moves on. The session is already in
    // `error` and shows up in Pendientes. A 5xx would make QStash retry it and, with
    // parallelism 1, every other send would wait behind it. Only a failure that a retry can
    // still fix answers 500.
    return NextResponse.json({ ok: false, final, tipo, error: message }, { status: final ? 200 : 500 })
  }
}
