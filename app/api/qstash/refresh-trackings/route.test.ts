import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/queue/verify', () => ({ verifyQstashSignature: vi.fn() }))
vi.mock('@/lib/cache/trackingActivos', () => ({ refreshTrackingActivos: vi.fn() }))
vi.mock('@/lib/audit', () => ({ registrarAuditoria: vi.fn() }))

import { registrarAuditoria } from '@/lib/audit'
import { refreshTrackingActivos } from '@/lib/cache/trackingActivos'
import { verifyQstashSignature } from '@/lib/queue/verify'
import { maxDuration, POST } from './route'

const mensaje = () =>
  new NextRequest('https://app.example.com/api/qstash/refresh-trackings', {
    method: 'POST',
    headers: { 'upstash-signature': 'firma' },
    body: '{}',
  })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(verifyQstashSignature).mockResolvedValue(true)
})

describe('POST /api/qstash/refresh-trackings', () => {
  it('rejects a bad signature with 401 and refreshes nothing', async () => {
    vi.mocked(verifyQstashSignature).mockResolvedValue(false)

    const res = await POST(mensaje())

    expect(res.status).toBe(401)
    expect(verifyQstashSignature).toHaveBeenCalledWith('firma', '{}')
    expect(refreshTrackingActivos).not.toHaveBeenCalled()
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('rebuilds the tracking cache, audits the summary as admin_refresco with no operario and answers 200', async () => {
    vi.mocked(refreshTrackingActivos).mockResolvedValue({ filas: 4123 })

    const res = await POST(mensaje())

    expect(res.status).toBe(200)
    expect(registrarAuditoria).toHaveBeenCalledOnce()
    expect(registrarAuditoria).toHaveBeenCalledWith({
      operarioId: null,
      accion: 'admin_refresco',
      detalle: { filas: 4123 },
    })
  })

  it('answers 500 and audits nothing when the rebuild fails, so QStash retries it', async () => {
    vi.mocked(refreshTrackingActivos).mockRejectedValue(new Error('fetch failed'))

    const res = await POST(mensaje())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'fetch failed' })
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  // Pages of 2000 move lines, one Odoo request per second: a big cache takes minutes.
  it('is allowed to run for five minutes', () => {
    expect(maxDuration).toBe(300)
  })
})
