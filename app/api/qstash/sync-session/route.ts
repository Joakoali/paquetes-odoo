import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { verifyQstashSignature } from '@/lib/queue/verify'
import { db } from '@/db/client'
import { sesionesEscaneo } from '@/db/schema'
import { syncRecepcionSession } from '@/lib/sync/recepcion'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text()
  const signature = request.headers.get('upstash-signature') ?? ''
  if (!(await verifyQstashSignature(signature, body))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  const { sesionId } = JSON.parse(body) as { sesionId: string }
  const sesion = await db.query.sesionesEscaneo.findFirst({ where: eq(sesionesEscaneo.id, sesionId) })
  if (!sesion) return NextResponse.json({ error: 'sesion not found' }, { status: 404 })

  try {
    if (sesion.tipo === 'recepcion') {
      await syncRecepcionSession(sesionId)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.update(sesionesEscaneo).set({
      estado: 'error',
      intentos: sesion.intentos + 1,
      ultimoError: message,
    }).where(eq(sesionesEscaneo.id, sesionId))
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
