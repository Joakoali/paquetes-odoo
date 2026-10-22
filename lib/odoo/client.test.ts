import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { odooCall, OdooError } from './client'

beforeEach(() => {
  process.env.ODOO_BASE_URL = 'https://test.odoo.com/'
  process.env.ODOO_API_KEY = 'fake-key'
})

afterEach(() => {
  vi.restoreAllMocks()
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

  it('OdooError exposes status, the Odoo exception name and its message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422,
      text: async () => JSON.stringify({ name: 'odoo.exceptions.ValidationError', message: 'Missing required field' }) }))
    const err = await odooCall('stock.move', 'create', {}).catch((e) => e)
    expect(err).toBeInstanceOf(OdooError)
    expect(err).toMatchObject({ status: 422, odooName: 'odoo.exceptions.ValidationError', message: 'Missing required field' })
  })

  it('keeps the HTTP status and the raw text in OdooError when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => '<html>Bad Gateway</html>',
    }))

    const err = await odooCall('stock.move', 'create', {}).catch((e) => e)

    expect(err).toBeInstanceOf(OdooError)
    expect(err).toMatchObject({ status: 502, odooName: null, data: '<html>Bad Gateway</html>' })
  })

  it('gives up on Odoo after 30 seconds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '1' })
    vi.stubGlobal('fetch', fetchMock)
    const timeout = vi.spyOn(AbortSignal, 'timeout')

    await odooCall('res.users', 'search', { domain: [] })

    expect(timeout).toHaveBeenCalledWith(30_000)
    expect(fetchMock.mock.calls[0][1].signal).toBe(timeout.mock.results[0].value)
  })

  it('throws when ODOO_BASE_URL or ODOO_API_KEY is missing', async () => {
    delete process.env.ODOO_API_KEY
    await expect(odooCall('res.users', 'search', { domain: [] })).rejects.toThrow(/must be set/)
  })
})

describe('OdooError', () => {
  it('uses the JSON of the answer as message when Odoo sent no usable message', () => {
    const noBody = new OdooError({ status: 503, data: null })
    expect(noBody.message).toBe('Odoo call failed: null')
    expect(noBody.odooName).toBeNull()

    const noMessage = new OdooError({ status: 500, data: { name: 'odoo.exceptions.UserError' } })
    expect(noMessage.message).toBe('Odoo call failed: {"name":"odoo.exceptions.UserError"}')
    expect(noMessage.odooName).toBe('odoo.exceptions.UserError')

    const emptyMessage = new OdooError({ status: 500, data: { name: 'builtins.AssertionError', message: '' } })
    expect(emptyMessage.message).toBe('Odoo call failed: {"name":"builtins.AssertionError","message":""}')
  })
})
