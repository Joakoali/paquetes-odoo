import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/queue/publish', () => ({
  publishRefreshMaestros: vi.fn(),
  publishRefreshTrackings: vi.fn(),
}))

import { publishRefreshMaestros, publishRefreshTrackings } from '@/lib/queue/publish'
import { GET } from './route'

function req(headers: Record<string, string> = {}) {
  return new NextRequest('https://app.example.com/api/cron/refresh-caches', { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'top-secret'
})

describe('GET /api/cron/refresh-caches', () => {
  it('rejects a request with no bearer token', async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(publishRefreshMaestros).not.toHaveBeenCalled()
    expect(publishRefreshTrackings).not.toHaveBeenCalled()
  })

  it('rejects a wrong bearer token', async () => {
    const res = await GET(req({ authorization: 'Bearer nope' }))
    expect(res.status).toBe(401)
    expect(publishRefreshMaestros).not.toHaveBeenCalled()
    expect(publishRefreshTrackings).not.toHaveBeenCalled()
  })

  it('enqueues the maestros and trackings refresh with the right bearer token', async () => {
    const res = await GET(req({ authorization: 'Bearer top-secret' }))
    expect(res.status).toBe(200)
    expect(publishRefreshMaestros).toHaveBeenCalledOnce()
    expect(publishRefreshTrackings).toHaveBeenCalledOnce()
  })

  it('rejects everything when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req({ authorization: 'Bearer top-secret' }))
    expect(res.status).toBe(401)
    expect(publishRefreshMaestros).not.toHaveBeenCalled()
    expect(publishRefreshTrackings).not.toHaveBeenCalled()
  })
})
