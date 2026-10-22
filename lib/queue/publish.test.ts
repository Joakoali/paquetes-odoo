import { describe, it, expect, vi, beforeEach } from 'vitest'

const upsert = vi.fn()
const enqueueJSON = vi.fn()
const queue = vi.fn(() => ({ upsert, enqueueJSON }))

vi.mock('@upstash/qstash', () => ({
  Client: class {
    queue = queue
  },
}))

import { MAX_REINTENTOS, publishSync, publishRefreshMaestros, publishRefreshTrackings } from './publish'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.QSTASH_TOKEN = 'tok'
  process.env.QSTASH_QUEUE_NAME = 'odoo-sync'
  process.env.APP_BASE_URL = 'https://app.example.com'
})

describe('publishSync', () => {
  it('enqueues onto the odoo-sync queue after making sure its parallelism is 1', async () => {
    await publishSync({ sesionId: 's1' })
    expect(queue).toHaveBeenCalledWith({ queueName: 'odoo-sync' })
    expect(upsert).toHaveBeenCalledWith({ parallelism: 1 })
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(enqueueJSON.mock.invocationCallOrder[0])
  })

  it('publishSync enqueues with bounded retries and a short delay', async () => {
    await publishSync({ sesionId: 's1' })
    expect(enqueueJSON).toHaveBeenCalledWith({
      url: 'https://app.example.com/api/qstash/sync-session',
      body: { sesionId: 's1' },
      retries: 2,
      retryDelay: '10000 * (1 + retried)',
    })
  })

  // registrarFalloSync takes `reintentosHechos >= MAX_REINTENTOS` as "QStash will not retry
  // again": if the queue were given more retries than that, the session would be marked as in
  // error while QStash kept redelivering it.
  it('asks QStash for exactly the retries registrarFalloSync counts on', async () => {
    await publishSync({ sesionId: 's1' })
    expect(enqueueJSON).toHaveBeenCalledWith(expect.objectContaining({ retries: MAX_REINTENTOS }))
  })
})

describe.each([
  ['publishRefreshMaestros', publishRefreshMaestros, '/api/qstash/refresh-maestros'],
  ['publishRefreshTrackings', publishRefreshTrackings, '/api/qstash/refresh-trackings'],
] as const)('%s', (_nombre, publish, ruta) => {
  it('enqueues its route onto the same parallelism-1 queue with a single retry', async () => {
    await publish()
    expect(queue).toHaveBeenCalledWith({ queueName: 'odoo-sync' })
    expect(upsert).toHaveBeenCalledWith({ parallelism: 1 })
    expect(enqueueJSON).toHaveBeenCalledWith({
      url: `https://app.example.com${ruta}`,
      body: {},
      retries: 1,
    })
  })
})
