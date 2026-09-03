import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  sesiones: [] as any[],
  batches: [] as any[],
  items: [] as any[],
}

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue({ value: 'test-token' }),
  }),
}))
vi.mock('../../../lib/auth/guards', () => ({
  requireOperario: vi.fn().mockResolvedValue({ id: 'op-1' }),
}))
vi.mock('../../../lib/cache/trackingActivos', () => ({
  isKnownDuplicate: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../../lib/queue/publish', () => ({ publishSync: vi.fn() }))
vi.mock('../../../db/client', () => ({
  db: {
    insert: (table: any) => ({
      values: (v: any) => ({
        returning: async () => {
          const id = `id-${Math.random()}`
          const row = { id, ...v }
          if (table === 'sesiones') state.sesiones.push(row)
          if (table === 'batches') state.batches.push(row)
          if (table === 'items') state.items.push(row)
          return [row]
        },
      }),
    }),
    update: () => ({ set: (v: any) => ({ where: async () => { Object.assign(state.sesiones[0], v) } }) }),
    query: {
      sesionItems: {
        findFirst: async ({ where }: any) => {
          // Handle both callback-style and Drizzle condition objects
          if (typeof where === 'function') {
            return state.items.find((r) => where(r, { eq: (a: any, b: any) => a === b, and: (...c: boolean[]) => c.every(Boolean) }))
          }

          // For Drizzle conditions, extract values and match against items
          const collectValues = (obj: any, collected = new Set<string>()): Set<string> => {
            if (!obj || typeof obj !== 'object') {
              if (typeof obj === 'string' && obj !== 'items') collected.add(obj)
              return collected
            }
            for (const key of Object.keys(obj)) {
              const val = obj[key]
              if (typeof val === 'string' && val !== 'items') collected.add(val)
              else if (typeof val === 'object') collectValues(val, collected)
            }
            return collected
          }

          const conditionValues = collectValues(where)

          // Find an item matching the condition values
          for (const item of state.items) {
            let matchCount = 0
            for (const v of conditionValues) {
              if (Object.values(item).includes(v)) matchCount++
            }
            if (matchCount >= 2 || (matchCount > 0 && conditionValues.size <= 1)) {
              return item
            }
          }
          return undefined
        },
      },
    },
  },
}))
vi.mock('../../../db/schema', () => ({
  sesionesEscaneo: 'sesiones', sesionCourierBatches: 'batches', sesionItems: 'items',
}))

import { isKnownDuplicate } from '../../../lib/cache/trackingActivos'
import { publishSync } from '../../../lib/queue/publish'
import { startSession, startCourierBatch, scanTracking, finishCourierBatch, confirmSession } from './actions'

beforeEach(() => {
  state.sesiones.length = 0
  state.batches.length = 0
  state.items.length = 0
  vi.mocked(isKnownDuplicate).mockResolvedValue(false)
})

describe('recepcion actions', () => {
  it('scanTracking marks ok when not a duplicate', async () => {
    const result = await scanTracking('batch-1', 'T1')
    expect(result.estado).toBe('ok')
    expect(state.items).toHaveLength(1)
    expect(state.items[0].trackingNumber).toBe('T1')
    expect(state.items[0].estado).toBe('ok')
    expect(state.items[0].courierBatchId).toBe('batch-1')
  })

  it('scanTracking marks duplicado when cache says so', async () => {
    vi.mocked(isKnownDuplicate).mockResolvedValue(true)
    const result = await scanTracking('batch-1', 'T2')
    expect(result.estado).toBe('duplicado')
    expect(state.items).toHaveLength(1)
    expect(state.items[0].trackingNumber).toBe('T2')
    expect(state.items[0].estado).toBe('duplicado')
    expect(state.items[0].courierBatchId).toBe('batch-1')
  })

  it('scanTracking detects in-session duplicates', async () => {
    const result1 = await scanTracking('batch-1', 'T1')
    expect(result1.estado).toBe('ok')
    expect(state.items).toHaveLength(1)

    const result2 = await scanTracking('batch-1', 'T1')
    expect(result2.estado).toBe('duplicado')
    expect(state.items).toHaveLength(2)
    expect(state.items[1].trackingNumber).toBe('T1')
    expect(state.items[1].estado).toBe('duplicado')
  })

  it('confirmSession transitions state and publishes to the sync queue', async () => {
    const sesionId = await startSession(1, 33)
    await confirmSession(sesionId)
    expect(state.sesiones[0].estado).toBe('confirmada_pendiente_sync')
    expect(publishSync).toHaveBeenCalledWith({ sesionId })
  })
})
