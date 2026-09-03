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

export async function callKw<T>(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  const baseUrl = process.env.ODOO_BASE_URL
  const apiKey = process.env.ODOO_API_KEY
  if (!baseUrl || !apiKey) {
    throw new Error('ODOO_BASE_URL and ODOO_API_KEY must be set')
  }

  await throttle()

  const response = await fetch(`${baseUrl}/json/2/${model}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ args, kwargs }),
  })

  const body = await response.json()
  if (!response.ok || body.error) {
    throw new OdooError(body.error ?? body)
  }
  return body.result as T
}
