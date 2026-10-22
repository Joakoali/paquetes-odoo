import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { odooCall, OdooError } from './client'
import { ConfiguracionError } from '../errores'

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

  it('cuts a long non-JSON body in the message but keeps it whole in data', async () => {
    const page = 'x'.repeat(2000)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => page }))

    const err = (await odooCall('stock.move', 'create', {}).catch((e) => e)) as OdooError

    expect(err).toBeInstanceOf(OdooError)
    expect(err.message.length).toBeLessThanOrEqual('Odoo call failed: '.length + 500)
    expect(err.message).toMatch(/^Odoo call failed: "xxxx/)
    expect(err.data).toBe(page)
  })

  it.each(['ODOO_BASE_URL', 'ODOO_API_KEY'])('throws ConfiguracionError when %s is missing', async (variable) => {
    delete process.env[variable]

    const err = (await odooCall('res.users', 'search', { domain: [] }).catch((e) => e)) as ConfiguracionError

    expect(err).toBeInstanceOf(ConfiguracionError)
    expect(err.message).toMatch(/ODOO_BASE_URL.*ODOO_API_KEY/)
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

  it('keeps at most 500 characters of the answer in the fallback message', () => {
    const prefix = 'Odoo call failed: '
    // JSON.stringify wraps a text body in two quotes, so 498 characters of text are exactly 500 of answer.
    const fits = new OdooError({ status: 502, data: 'x'.repeat(498) })
    expect(fits.message).toBe(`${prefix}"${'x'.repeat(498)}"`)

    const tooLong = new OdooError({ status: 502, data: 'x'.repeat(499) })
    expect(tooLong.message).toBe(`${prefix}"${'x'.repeat(498)}…`)

    const longJson = new OdooError({ status: 500, data: { name: 'builtins.Exception', debug: 'y'.repeat(2000) } })
    expect(longJson.message).toHaveLength(prefix.length + 500)
  })
})
