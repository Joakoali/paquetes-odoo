import { Client } from '@upstash/qstash'

export async function publishSync(payload: { sesionId: string }): Promise<void> {
  const client = new Client({ token: process.env.QSTASH_TOKEN! })
  const queueName = process.env.QSTASH_QUEUE_NAME ?? 'odoo-sync'
  const queue = client.queue({ queueName })
  await queue.upsert({ parallelism: 1 })
  await queue.enqueueJSON({
    url: `${process.env.APP_BASE_URL}/api/qstash/sync-session`,
    body: payload,
  })
}
