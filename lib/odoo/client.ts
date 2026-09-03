export class OdooError extends Error {
  constructor(public data: unknown) {
    super(`Odoo call failed: ${JSON.stringify(data)}`)
  }
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
