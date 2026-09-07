export class OdooError extends Error {
  constructor(public data: unknown) {
    super(`Odoo call failed: ${JSON.stringify(data)}`)
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
 * status and an `{ name, message, arguments, … }` body.
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
  })

  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new OdooError({ status: response.status, body: text })
    }
  }
  if (!response.ok) throw new OdooError(body ?? { status: response.status })
  return body as T
}
