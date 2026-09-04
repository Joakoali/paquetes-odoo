import { Client } from '@upstash/qstash'

/**
 * The single `odoo-sync` queue. `parallelism: 1` is what enforces Odoo's
 * ≤1 request/second limit globally — every job that ends up calling Odoo
 * (session syncs and the barcos refresh alike) rides this one queue.
 */
function odooSyncQueue() {
  const client = new Client({ token: process.env.QSTASH_TOKEN! })
  const queueName = process.env.QSTASH_QUEUE_NAME ?? 'odoo-sync'
  return client.queue({ queueName })
}

export async function publishSync(payload: { sesionId: string }): Promise<void> {
  const queue = odooSyncQueue()
  await queue.upsert({ parallelism: 1 })
  await queue.enqueueJSON({
    url: `${process.env.APP_BASE_URL}/api/qstash/sync-session`,
    body: payload,
  })
}

export async function publishRefreshBarcos(): Promise<void> {
  const queue = odooSyncQueue()
  await queue.upsert({ parallelism: 1 })
  await queue.enqueueJSON({
    url: `${process.env.APP_BASE_URL}/api/qstash/refresh-barcos`,
    body: {},
  })
}
