import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('@/lib/queue/verify', () => ({ verifyQstashSignature: vi.fn() }))
vi.mock('@/lib/sync/recepcion', () => ({ syncRecepcionSession: vi.fn() }))
vi.mock('@/lib/sync/entrega', () => ({ syncEntregaSession: vi.fn() }))
vi.mock('@/lib/sync/estado', () => ({ registrarFalloSync: vi.fn() }))

import { db } from '@/db/client'
import { sesionesEscaneo } from '@/db/schema'
import { verifyQstashSignature } from '@/lib/queue/verify'
import { syncEntregaSession } from '@/lib/sync/entrega'
import { registrarFalloSync } from '@/lib/sync/estado'
import { syncRecepcionSession } from '@/lib/sync/recepcion'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { POST } from './route'

let recepcionId: string
let entregaId: string

beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(verifyQstashSignature).mockResolvedValue(true)

  await resetTestDb(db as unknown as TestDb)
  const operario = await seedOperario(db)
  const almacen = await seedAlmacen(db)
  const base = {
    operarioId: operario.id,
    almacenId: almacen.id,
    barcoOdooId: 673,
    estado: 'confirmada_pendiente_sync' as const,
  }
  const [recepcion, entrega] = await db.insert(sesionesEscaneo).values([
    { ...base, tipo: 'recepcion' },
    { ...base, tipo: 'entrega' },
  ]).returning()
  recepcionId = recepcion.id
  entregaId = entrega.id
})

/** What QStash sends: the signed body and, from the first retry on, how many retries it has made. */
function mensaje(body: string, headers: Record<string, string> = {}) {
  return new NextRequest('https://app.example.com/api/qstash/sync-session', {
    method: 'POST',
    headers: { 'upstash-signature': 'firma', ...headers },
    body,
  })
}
const mensajeDe = (sesionId: string, headers: Record<string, string> = {}) =>
  mensaje(JSON.stringify({ sesionId }), headers)

describe('POST /api/qstash/sync-session', () => {
  it('rejects a bad signature with 401 and does nothing', async () => {
    vi.mocked(verifyQstashSignature).mockResolvedValue(false)

    const res = await POST(mensajeDe(recepcionId))

    expect(res.status).toBe(401)
    expect(verifyQstashSignature).toHaveBeenCalledWith('firma', JSON.stringify({ sesionId: recepcionId }))
    expect(syncRecepcionSession).not.toHaveBeenCalled()
    expect(syncEntregaSession).not.toHaveBeenCalled()
    expect(registrarFalloSync).not.toHaveBeenCalled()
  })

  it('rejects a body that is not JSON with 400', async () => {
    const res = await POST(mensaje('no es json'))

    expect(res.status).toBe(400)
    expect(registrarFalloSync).not.toHaveBeenCalled()
  })

  it('answers 404 for a session that does not exist', async () => {
    const res = await POST(mensajeDe('00000000-0000-4000-8000-000000000000'))

    expect(res.status).toBe(404)
    expect(syncRecepcionSession).not.toHaveBeenCalled()
    expect(syncEntregaSession).not.toHaveBeenCalled()
  })

  it('syncs a recepción with the recepción worker and answers 200', async () => {
    const res = await POST(mensajeDe(recepcionId))

    expect(res.status).toBe(200)
    expect(syncRecepcionSession).toHaveBeenCalledWith(recepcionId)
    expect(syncEntregaSession).not.toHaveBeenCalled()
    expect(registrarFalloSync).not.toHaveBeenCalled()
  })

  it('syncs an entrega with the entrega worker and answers 200', async () => {
    const res = await POST(mensajeDe(entregaId))

    expect(res.status).toBe(200)
    expect(syncEntregaSession).toHaveBeenCalledWith(entregaId)
    expect(syncRecepcionSession).not.toHaveBeenCalled()
    expect(registrarFalloSync).not.toHaveBeenCalled()
  })

  it('returns 500 so QStash retries when the failure is not final', async () => {
    vi.mocked(syncRecepcionSession).mockRejectedValue(new TypeError('fetch failed'))
    vi.mocked(registrarFalloSync).mockResolvedValue({ final: false, tipo: 'conexion' })

    const res = await POST(mensajeDe(recepcionId))

    expect(res.status).toBe(500)
  })

  it('returns 200 when the failure is final so the queue never blocks', async () => {
    vi.mocked(syncEntregaSession).mockRejectedValue(new Error('picking 5 no existe en Odoo'))
    vi.mocked(registrarFalloSync).mockResolvedValue({ final: true, tipo: 'odoo' })

    const res = await POST(mensajeDe(entregaId))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, final: true, tipo: 'odoo', error: 'picking 5 no existe en Odoo' })
  })

  it('passes the upstash-retried header as reintentosHechos', async () => {
    const error = new TypeError('fetch failed')
    vi.mocked(syncRecepcionSession).mockRejectedValue(error)
    vi.mocked(registrarFalloSync).mockResolvedValue({ final: true, tipo: 'conexion' })

    await POST(mensajeDe(recepcionId, { 'upstash-retried': '2' }))

    expect(registrarFalloSync).toHaveBeenCalledOnce()
    expect(registrarFalloSync).toHaveBeenCalledWith({ sesionId: recepcionId, error, reintentosHechos: 2 })
  })

  it('counts no retries done when the header is missing', async () => {
    const error = new TypeError('fetch failed')
    vi.mocked(syncRecepcionSession).mockRejectedValue(error)
    vi.mocked(registrarFalloSync).mockResolvedValue({ final: false, tipo: 'conexion' })

    await POST(mensajeDe(recepcionId))

    expect(registrarFalloSync).toHaveBeenCalledWith({ sesionId: recepcionId, error, reintentosHechos: 0 })
  })
})
