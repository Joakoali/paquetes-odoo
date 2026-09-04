import { describe, it, expect, vi, beforeEach } from 'vitest'

const upsert = vi.fn()
const enqueueJSON = vi.fn()
const queue = vi.fn(() => ({ upsert, enqueueJSON }))

vi.mock('@upstash/qstash', () => ({
  Client: class {
    queue = queue
  },
}))

import { publishSync, publishRefreshBarcos } from './publish'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.QSTASH_TOKEN = 'tok'
  process.env.QSTASH_QUEUE_NAME = 'odoo-sync'
  process.env.APP_BASE_URL = 'https://app.example.com'
})

describe('publishSync', () => {
  it('enqueues the session id onto the parallelism-1 queue', async () => {
    await publishSync({ sesionId: 's1' })
    expect(queue).toHaveBeenCalledWith({ queueName: 'odoo-sync' })
    expect(upsert).toHaveBeenCalledWith({ parallelism: 1 })
    expect(enqueueJSON).toHaveBeenCalledWith({
      url: 'https://app.example.com/api/qstash/sync-session',
      body: { sesionId: 's1' },
    })
  })
})

describe('publishRefreshBarcos', () => {
  it('enqueues a refresh job onto the same parallelism-1 queue', async () => {
    await publishRefreshBarcos()
    expect(queue).toHaveBeenCalledWith({ queueName: 'odoo-sync' })
    expect(upsert).toHaveBeenCalledWith({ parallelism: 1 })
    expect(enqueueJSON).toHaveBeenCalledWith({
      url: 'https://app.example.com/api/qstash/refresh-barcos',
      body: {},
    })
  })
})
