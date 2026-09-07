import { describe, it, expect, vi, beforeEach } from 'vitest'
import { odooCall, OdooError } from './client'

beforeEach(() => {
  process.env.ODOO_BASE_URL = 'https://test.odoo.com/'
  process.env.ODOO_API_KEY = 'fake-key'
})

describe('odooCall', () => {
  it('posts a flat JSON-2 body to <base>/json/2/<model>/<method> and returns the raw result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ id: 1, name: 'Test' }]),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await odooCall<Array<{ id: number; name: string }>>(
      'project.project', 'search_read', { domain: [], fields: ['name'] },
    )

    expect(result).toEqual([{ id: 1, name: 'Test' }])
    expect(fetchMock).toHaveBeenCalledWith(
      // trailing slash on the base URL is trimmed
      'https://test.odoo.com/json/2/project.project/search_read',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fake-key',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ domain: [], fields: ['name'] }),
      }),
    )
  })

  it('throws OdooError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ name: 'werkzeug.exceptions.Unauthorized', message: 'Invalid apikey' }),
    }))

    await expect(odooCall('stock.picking', 'create', { vals_list: [{}] })).rejects.toThrow(OdooError)
  })

  it('throws when ODOO_BASE_URL or ODOO_API_KEY is missing', async () => {
    delete process.env.ODOO_API_KEY
    await expect(odooCall('res.users', 'search', { domain: [] })).rejects.toThrow(/must be set/)
  })
})
