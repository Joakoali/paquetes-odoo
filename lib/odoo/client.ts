/** Past this Odoo is down or overloaded, and a hung call would hold the whole queue. */
export const ODOO_TIMEOUT_MS = 30_000

/** `key` of an Odoo answer body when it is a non-empty string, else null. */
function textField(data: unknown, key: 'name' | 'message'): string | null {
  if (typeof data !== 'object' || data === null) return null
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * A non-2xx answer from Odoo, or a 2xx whose body is not JSON. `data` is what
 * came back: the parsed JSON, the raw text when it was not JSON (a proxy error
 * page), or null for an empty body. `odooName` is the exception Odoo reports
 * (`odoo.exceptions.UserError`, …); it is only there when Odoo itself answered,
 * which is how a rejected request is told apart from a gateway error.
 */
export class OdooError extends Error {
  readonly status: number
  readonly odooName: string | null
  readonly data: unknown

  constructor(info: { status: number; data: unknown }) {
    super(textField(info.data, 'message') ?? `Odoo call failed: ${JSON.stringify(info.data)}`)
    this.status = info.status
    this.odooName = textField(info.data, 'name')
    this.data = info.data
  }
}

const MIN_INTERVAL_MS = 1000

/**
 * Spec: ~1 request/second against Odoo. QStash parallelism:1 only stops
 * *concurrent* jobs — back-to-back calls inside one job, and the reads that run
 * outside the queue, still need spacing. Module-level, so it holds for every
 * call made by the same process/lambda instance.
 */
let nextSlotAt = 0

async function throttle(): Promise<void> {
  const now = Date.now()
  const slot = Math.max(now, nextSlotAt)
  nextSlotAt = slot + MIN_INTERVAL_MS
  const wait = slot - now
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

/**
 * Odoo 19 JSON-2 API: `POST /json/2/<model>/<method>`, `Authorization: Bearer`.
 * The body is a *flat* JSON object whose keys are the target method's own
 * parameters (`domain`, `fields`, `vals_list`, `vals`, …) plus optionally
 * `ids` (the recordset the method runs on) and `context`. The response is the
 * raw result — no `{ "result": … }` envelope. Errors come back with a non-2xx
 * status and an `{ name, message, arguments, … }` body, thrown as `OdooError`.
 * A call that gets no answer within `ODOO_TIMEOUT_MS` is aborted and rejects
 * with the `TimeoutError` that `fetch` raises, not with an `OdooError`.
 *
 * NOT the classic JSON-RPC `{ args, kwargs }` shape — that returns 422
 * "missing a required argument" against this instance.
 */
export async function odooCall<T>(
  model: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const rawBase = process.env.ODOO_BASE_URL
  const apiKey = process.env.ODOO_API_KEY
  if (!rawBase || !apiKey) {
    throw new Error('ODOO_BASE_URL and ODOO_API_KEY must be set')
  }
  const baseUrl = rawBase.replace(/\/+$/, '')

  await throttle()

  const response = await fetch(`${baseUrl}/json/2/${model}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
    // Built here, after throttle(): waiting for the 1 req/s slot must not eat into it.
    signal: AbortSignal.timeout(ODOO_TIMEOUT_MS),
  })

  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new OdooError({ status: response.status, data: text })
    }
  }
  if (!response.ok) throw new OdooError({ status: response.status, data: body })
  return body as T
}
