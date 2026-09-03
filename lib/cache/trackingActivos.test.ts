import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: Array<{ trackingNumber: string; odooPickingId: number }> = []
vi.mock('../../db/client', () => ({
  db: {
    query: {
      trackingActivosCache: {
        findFirst: async ({ where }: any) => {
          // Mock: find row by trackingNumber (ignoring the where condition object structure)
          if (rows.length === 0) return undefined
          // For this test, we just find the first row with matching trackingNumber
          // The actual where condition passed is eq(trackingActivosCache.trackingNumber, trackingNumber)
          return rows[0] ?? undefined
        },
      },
    },
    insert: () => ({
      values: (v: any) => ({
        onConflictDoUpdate: async () => { rows.push(v) },
      }),
    }),
  },
}))

import { isKnownDuplicate, recordSyncedTracking } from './trackingActivos'

beforeEach(() => { rows.length = 0 })

describe('tracking activos cache', () => {
  it('isKnownDuplicate is false when not present', async () => {
    expect(await isKnownDuplicate('ABC')).toBe(false)
  })

  it('recordSyncedTracking then isKnownDuplicate is true', async () => {
    await recordSyncedTracking('ABC', 501)
    expect(await isKnownDuplicate('ABC')).toBe(true)
  })
})
