import { describe, it, expect, vi } from 'vitest'

vi.mock('@upstash/qstash', () => ({
  Receiver: class {
    verify() {
      return this._shouldFail ? Promise.reject(new Error('bad signature')) : Promise.resolve(true)
    }
    _shouldFail = false
  },
}))

import { verifyQstashSignature } from './verify'

describe('verifyQstashSignature', () => {
  it('returns true for a well-formed call', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'current'
    process.env.QSTASH_NEXT_SIGNING_KEY = 'next'
    const result = await verifyQstashSignature('sig', '{"sesionId":"s1"}')
    expect(result).toBe(true)
  })
})
