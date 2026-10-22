import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/queue/verify', () => ({ verifyQstashSignature: vi.fn() }))
vi.mock('@/lib/maestros/refresh', () => ({ refreshMaestros: vi.fn() }))
vi.mock('@/lib/audit', () => ({ registrarAuditoria: vi.fn() }))

import { registrarAuditoria } from '@/lib/audit'
import { refreshMaestros } from '@/lib/maestros/refresh'
import { verifyQstashSignature } from '@/lib/queue/verify'
import { maxDuration, POST } from './route'

const mensaje = () =>
  new NextRequest('https://app.example.com/api/qstash/refresh-maestros', {
    method: 'POST',
    headers: { 'upstash-signature': 'firma' },
    body: '{}',
  })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(verifyQstashSignature).mockResolvedValue(true)
})

describe('POST /api/qstash/refresh-maestros', () => {
  it('rejects a bad signature with 401 and refreshes nothing', async () => {
    vi.mocked(verifyQstashSignature).mockResolvedValue(false)

    const res = await POST(mensaje())

    expect(res.status).toBe(401)
    expect(verifyQstashSignature).toHaveBeenCalledWith('firma', '{}')
    expect(refreshMaestros).not.toHaveBeenCalled()
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('refreshes the maestros, audits the summary as admin_refresco with no operario and answers 200', async () => {
    vi.mocked(refreshMaestros).mockResolvedValue({ almacenes: 8, couriers: 22, barcos: 491 })

    const res = await POST(mensaje())

    expect(res.status).toBe(200)
    expect(registrarAuditoria).toHaveBeenCalledOnce()
    expect(registrarAuditoria).toHaveBeenCalledWith({
      operarioId: null,
      accion: 'admin_refresco',
      detalle: { almacenes: 8, couriers: 22, barcos: 491 },
    })
  })

  it('answers 500 and audits nothing when the refresh fails, so QStash retries it', async () => {
    vi.mocked(refreshMaestros).mockRejectedValue(new Error('Odoo call failed: null'))

    const res = await POST(mensaje())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Odoo call failed: null' })
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  // Four Odoo reads, 1 s apart, ahead of other jobs on the odoo-sync queue: past Vercel's default.
  it('is allowed to run for five minutes', () => {
    expect(maxDuration).toBe(300)
  })
})
