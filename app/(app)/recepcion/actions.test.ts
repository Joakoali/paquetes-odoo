import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  sesiones: [] as any[],
  batches: [] as any[],
  items: [] as any[],
  nextId: 0,
}

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue({ value: 'test-token' }),
  }),
}))
vi.mock('../../../lib/auth/current-operario', () => ({
  requireOperarioFromCookies: vi.fn().mockResolvedValue({ id: 'op-1' }),
}))
vi.mock('../../../lib/admin/operarioAlmacenes', () => ({
  operarioHasAlmacen: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../../lib/cache/trackingActivos', () => ({
  isKnownDuplicate: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../../lib/queue/publish', () => ({ publishSync: vi.fn() }))

// Relational-query helpers the actions pass to their `where` callbacks.
const ops = {
  eq: (a: any, b: any) => a === b,
  and: (...c: boolean[]) => c.every(Boolean),
  inArray: (a: any, list: any[]) => list.includes(a),
}

vi.mock('../../../db/client', () => ({
  db: {
    insert: (table: any) => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { id: `id-${state.nextId++}`, ...v }
          if (table === 'sesiones') state.sesiones.push(row)
          if (table === 'batches') state.batches.push(row)
          if (table === 'items') state.items.push(row)
          return [row]
        },
      }),
    }),
    update: () => ({ set: (v: any) => ({ where: async () => { Object.assign(state.sesiones[0], v) } }) }),
    query: {
      sesionesEscaneo: {
        findFirst: async ({ where }: any) => state.sesiones.find((r) => where(r, ops)),
      },
      sesionCourierBatches: {
        findFirst: async ({ where }: any) => state.batches.find((r) => where(r, ops)),
        findMany: async ({ where }: any) => state.batches.filter((r) => where(r, ops)),
      },
      sesionItems: {
        findFirst: async ({ where }: any) => state.items.find((r) => where(r, ops)),
      },
    },
  },
}))
vi.mock('../../../db/schema', () => ({
  sesionesEscaneo: 'sesiones', sesionCourierBatches: 'batches', sesionItems: 'items',
}))

import { isKnownDuplicate } from '../../../lib/cache/trackingActivos'
import { operarioHasAlmacen } from '../../../lib/admin/operarioAlmacenes'
import { publishSync } from '../../../lib/queue/publish'
import { startSession, startCourierBatch, scanTracking, finishCourierBatch, confirmSession } from './actions'

/** A session owned by op-1 with one courier batch, as the UI would create it. */
async function seedSession(): Promise<{ sesionId: string; batchId: string }> {
  const sesionId = await startSession(1, 33)
  const batchId = await startCourierBatch(sesionId, 10)
  return { sesionId, batchId }
}

beforeEach(async () => {
  state.sesiones.length = 0
  state.batches.length = 0
  state.items.length = 0
  state.nextId = 0
  vi.mocked(isKnownDuplicate).mockResolvedValue(false)
  vi.mocked(operarioHasAlmacen).mockResolvedValue(true)
  vi.mocked(publishSync).mockClear()
})

describe('recepcion actions', () => {
  it('scanTracking marks ok when not a duplicate', async () => {
    const { batchId } = await seedSession()
    const result = await scanTracking(batchId, 'T1')
    expect(result.estado).toBe('ok')
    expect(state.items).toHaveLength(1)
    expect(state.items[0].trackingNumber).toBe('T1')
    expect(state.items[0].estado).toBe('ok')
    expect(state.items[0].courierBatchId).toBe(batchId)
  })

  it('scanTracking marks duplicado when cache says so', async () => {
    const { batchId } = await seedSession()
    vi.mocked(isKnownDuplicate).mockResolvedValue(true)
    const result = await scanTracking(batchId, 'T2')
    expect(result.estado).toBe('duplicado')
    expect(state.items).toHaveLength(1)
    expect(state.items[0].estado).toBe('duplicado')
  })

  it('re-scanning the same tracking in the same batch reports duplicado and inserts nothing', async () => {
    const { batchId } = await seedSession()
    expect((await scanTracking(batchId, 'T1')).estado).toBe('ok')
    expect(state.items).toHaveLength(1)

    expect((await scanTracking(batchId, 'T1')).estado).toBe('duplicado')
    expect(state.items).toHaveLength(1)
  })

  it('detects a duplicate across courier batches of the same session', async () => {
    const { sesionId, batchId } = await seedSession()
    expect((await scanTracking(batchId, 'T1')).estado).toBe('ok')

    const otherBatchId = await startCourierBatch(sesionId, 11)
    expect((await scanTracking(otherBatchId, 'T1')).estado).toBe('duplicado')
    expect(state.items).toHaveLength(1)
  })

  it('does not flag the same tracking scanned in a different session', async () => {
    const first = await seedSession()
    await scanTracking(first.batchId, 'T1')

    const second = await seedSession()
    expect((await scanTracking(second.batchId, 'T1')).estado).toBe('ok')
    expect(state.items).toHaveLength(2)
  })

  it('startSession rejects an almacen the operario is not assigned to', async () => {
    vi.mocked(operarioHasAlmacen).mockResolvedValue(false)
    await expect(startSession(9, 33)).rejects.toThrow(/almacén 9/)
  })

  it('scanTracking rejects a batch belonging to another operario', async () => {
    const { batchId } = await seedSession()
    state.sesiones[0].operarioId = 'someone-else'
    await expect(scanTracking(batchId, 'T1')).rejects.toThrow(/no pertenece/)
  })

  it('finishCourierBatch rejects a batch belonging to another operario', async () => {
    const { batchId } = await seedSession()
    state.sesiones[0].operarioId = 'someone-else'
    await expect(finishCourierBatch(batchId)).rejects.toThrow(/no pertenece/)
  })

  it('confirmSession transitions state and publishes to the sync queue', async () => {
    const { sesionId } = await seedSession()
    await confirmSession(sesionId)
    expect(state.sesiones[0].estado).toBe('confirmada_pendiente_sync')
    expect(publishSync).toHaveBeenCalledWith({ sesionId })
  })

  it('confirmSession is a no-op once the session is already confirmed', async () => {
    const { sesionId } = await seedSession()
    await confirmSession(sesionId)
    vi.mocked(publishSync).mockClear()
    await confirmSession(sesionId)
    expect(publishSync).not.toHaveBeenCalled()
  })

  it('confirmSession rejects a session belonging to another operario', async () => {
    const { sesionId } = await seedSession()
    state.sesiones[0].operarioId = 'someone-else'
    await expect(confirmSession(sesionId)).rejects.toThrow(/no pertenece/)
  })
})
