import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: Array<{ trackingNumber: string; odooPickingId: number }> = []
vi.mock('../../db/client', () => ({
  db: {
    query: {
      trackingActivosCache: {
        findFirst: async ({ where }: any) => {
          // Test-only mock: extract compared value from Drizzle eq() condition object.
          // The where object is a SQL expression with queryChunks array containing Param objects with the value.
          let searchValue = null
          if (Array.isArray((where as any)?.queryChunks)) {
            // Find the Param object in queryChunks array
            const paramChunk = (where as any).queryChunks.find((chunk: any) => chunk?.value !== undefined && typeof chunk.value === 'string')
            if (paramChunk) searchValue = paramChunk.value
          }
          if (!searchValue) return undefined
          return rows.find((r) => r.trackingNumber === searchValue) ?? undefined
        },
      },
    },
    insert: () => ({
      values: (v: any) => ({
        onConflictDoUpdate: async () => {
          // Real Drizzle takes either one row or an array of rows.
          for (const row of Array.isArray(v) ? v : [v]) {
            const existing = rows.find((r) => r.trackingNumber === row.trackingNumber)
            if (existing) Object.assign(existing, row)
            else rows.push(row)
          }
        },
      }),
    }),
  },
}))

import { isKnownDuplicate, recordSyncedTracking, recordSyncedTrackings } from './trackingActivos'

beforeEach(() => { rows.length = 0 })

describe('tracking activos cache', () => {
  it('isKnownDuplicate is false when not present', async () => {
    expect(await isKnownDuplicate('ABC')).toBe(false)
  })

  it('recordSyncedTracking then isKnownDuplicate is true', async () => {
    await recordSyncedTracking('ABC', 501)
    expect(await isKnownDuplicate('ABC')).toBe(true)
  })

  it('isKnownDuplicate filters by trackingNumber', async () => {
    await recordSyncedTracking('ABC', 501)
    await recordSyncedTracking('XYZ', 502)
    expect(await isKnownDuplicate('ABC')).toBe(true)
    expect(await isKnownDuplicate('XYZ')).toBe(true)
    expect(await isKnownDuplicate('DEF')).toBe(false)
  })

  it('recordSyncedTrackings upserts every pair in one call', async () => {
    await recordSyncedTrackings([
      { trackingNumber: 'ABC', odooPickingId: 501 },
      { trackingNumber: 'XYZ', odooPickingId: 501 },
    ])
    expect(rows).toHaveLength(2)
    expect(await isKnownDuplicate('ABC')).toBe(true)
    expect(await isKnownDuplicate('XYZ')).toBe(true)
  })

  it('recordSyncedTrackings is a no-op for an empty list', async () => {
    await recordSyncedTrackings([])
    expect(rows).toHaveLength(0)
  })
})
