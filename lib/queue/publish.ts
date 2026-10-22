import { Client } from '@upstash/qstash'

/**
 * How many times QStash redelivers a session sync that failed with something a retry can fix
 * (the connection to Odoo). A session is delivered at most `MAX_REINTENTOS + 1` times, and the
 * last delivery carries `Upstash-Retried: MAX_REINTENTOS`: that is how `registrarFalloSync`
 * knows it has to give up instead of asking for one more.
 *
 * Bounded on purpose. The queue has `parallelism: 1`, so a message that QStash keeps retrying
 * holds back every other send until someone purges it by hand.
 */
export const MAX_REINTENTOS = 2

/**
 * Wait before each retry, in ms (`retried` counts from 0): 10 s, then 20 s. Short, because
 * the whole queue waits along with the message.
 */
const ESPERA_REINTENTO = '10000 * (1 + retried)'

/**
 * A refresh that fails is made up for by the next one, so a single retry is enough to
 * cover a blip without keeping the queue busy.
 */
const REINTENTOS_REFRESCO = 1

/**
 * The single `odoo-sync` queue. `parallelism: 1` is what enforces Odoo's
 * ≤1 request/second limit globally — every job that ends up calling Odoo
 * (session syncs and the maestros and trackings refreshes alike) rides this one queue.
 */
function odooSyncQueue() {
  const client = new Client({ token: process.env.QSTASH_TOKEN! })
  const queueName = process.env.QSTASH_QUEUE_NAME ?? 'odoo-sync'
  return client.queue({ queueName })
}

async function enqueue(
  ruta: string,
  body: object,
  opciones: { retries: number; retryDelay?: string },
): Promise<void> {
  const queue = odooSyncQueue()
  await queue.upsert({ parallelism: 1 })
  await queue.enqueueJSON({
    url: `${process.env.APP_BASE_URL}/api/qstash/${ruta}`,
    body,
    ...opciones,
  })
}

export async function publishSync(payload: { sesionId: string }): Promise<void> {
  await enqueue('sync-session', payload, { retries: MAX_REINTENTOS, retryDelay: ESPERA_REINTENTO })
}

/** Almacenes, couriers, barcos and courier usage, read from Odoo. */
export async function publishRefreshMaestros(): Promise<void> {
  await enqueue('refresh-maestros', {}, { retries: REINTENTOS_REFRESCO })
}

/** The tracking-number cache, rebuilt from Odoo. */
export async function publishRefreshTrackings(): Promise<void> {
  await enqueue('refresh-trackings', {}, { retries: REINTENTOS_REFRESCO })
}
