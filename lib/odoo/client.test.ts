import { describe, it, expect, vi, beforeEach } from 'vitest'
import { callKw, OdooError } from './client'

beforeEach(() => {
  process.env.ODOO_BASE_URL = 'https://test.odoo.com'
  process.env.ODOO_API_KEY = 'fake-key'
})

describe('callKw', () => {
  it('posts to the JSON-2 endpoint with bearer auth and returns the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: [{ id: 1, name: 'Test' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await callKw<Array<{ id: number; name: string }>>(
      'project.project', 'search_read', [[]], { fields: ['name'] },
    )

    expect(result).toEqual([{ id: 1, name: 'Test' }])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://test.odoo.com/json/2/project.project/search_read',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fake-key',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ args: [[]], kwargs: { fields: ['name'] } }),
      }),
    )
  })

  it('throws OdooError on an Odoo-shaped error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: { code: 200, message: 'Access denied' } }),
    }))

    await expect(callKw('stock.picking', 'create', [[]])).rejects.toThrow(OdooError)
  })
})
