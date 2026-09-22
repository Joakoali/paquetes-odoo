import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../odoo/pickings', () => ({
  checkDuplicateTrackingNumbers: vi.fn(),
  createIncomingPicking: vi.fn(),
  addCourierMoveWithLines: vi.fn(),
  validatePicking: vi.fn(),
}))
vi.mock('../odoo/client', () => ({ odooCall: vi.fn() }))
vi.mock('../cache/trackingActivos', () => ({ recordSyncedTrackings: vi.fn() }))

const dbState = {
  sesion: {
    id: 's1', almacenId: 1, barcoOdooId: 33, odooPickingId: null as number | null,
    estado: 'confirmada_pendiente_sync', intentos: 0, ultimoError: null as string | null,
  },
  almacen: { id: 1, odooPickingTypeId: 7 },
  batches: [
    { id: 'b1', sesionId: 's1', courierId: 10, odooMoveId: null as number | null },
    { id: 'b2', sesionId: 's1', courierId: 11, odooMoveId: null as number | null },
  ],
  courierProductIds: { 10: 100, 11: 101 } as Record<number, number>,
  items: [
    { id: 'i1', courierBatchId: 'b1', trackingNumber: 'T1', estado: 'ok' },
    { id: 'i2', courierBatchId: 'b2', trackingNumber: 'T2', estado: 'ok' },
  ],
}

// The relational-query helpers the worker passes to its `where` callbacks.
const ops = {
  eq: (a: any, b: any) => a === b,
  ne: (a: any, b: any) => a !== b,
  and: (...c: boolean[]) => c.every(Boolean),
}

vi.mock('../../db/client', () => ({
  db: {
    query: {
      sesionesEscaneo: { findFirst: async () => dbState.sesion },
      almacenes: { findFirst: async () => dbState.almacen },
      sesionCourierBatches: { findMany: async ({ where }: any) =>
        dbState.batches.filter((b) => where(b, ops)) },
      couriers: { findFirst: async ({ where }: any) => {
        const id = Object.keys(dbState.courierProductIds).find((k) => where({ id: Number(k) }, ops))
        return id ? { id: Number(id), odooProductId: dbState.courierProductIds[Number(id)] } : undefined
      } },
      sesionItems: { findMany: async ({ where }: any) =>
        dbState.items.filter((i) => where(i, ops)) },
    },
    // Best-effort: pull every string literal out of the drizzle where-expression
    // so an update scoped to sesion_items rows can be routed to those items.
    update: () => ({
      set: (v: any) => ({
        where: async (cond: any) => {
          const vals = new Set<string>()
          const seen = new Set<any>()
          const walk = (o: any) => {
            if (o == null || seen.has(o)) return
            if (typeof o === 'string') { vals.add(o); return }
            if (typeof o !== 'object') return
            seen.add(o)
            for (const k of Object.keys(o)) walk(o[k])
          }
          walk(cond)
          const matchedItems = dbState.items.filter((i) => vals.has(i.trackingNumber) && vals.has(i.courierBatchId))
          const matchedBatches = dbState.batches.filter((b) => vals.has(b.id) && 'odooMoveId' in v)
          if (matchedItems.length > 0) {
            for (const i of matchedItems) Object.assign(i, v)
          } else if (matchedBatches.length > 0) {
            for (const b of matchedBatches) Object.assign(b, v)
          } else {
            Object.assign(dbState.sesion, v)
          }
        },
      }),
    }),
    insert: () => ({ values: async () => {} }),
  },
}))

import { checkDuplicateTrackingNumbers, createIncomingPicking, addCourierMoveWithLines, validatePicking } from '../odoo/pickings'
import { recordSyncedTrackings } from '../cache/trackingActivos'
import { odooCall } from '../odoo/client'
import { syncRecepcionSession } from './recepcion'

beforeEach(() => {
  vi.clearAllMocks()
  dbState.sesion.odooPickingId = null
  dbState.sesion.estado = 'confirmada_pendiente_sync'
  dbState.sesion.ultimoError = null
  dbState.batches.length = 0
  dbState.batches.push(
    { id: 'b1', sesionId: 's1', courierId: 10, odooMoveId: null },
    { id: 'b2', sesionId: 's1', courierId: 11, odooMoveId: null },
  )
  dbState.items.length = 0
  dbState.items.push(
    { id: 'i1', courierBatchId: 'b1', trackingNumber: 'T1', estado: 'ok' },
    { id: 'i2', courierBatchId: 'b2', trackingNumber: 'T2', estado: 'ok' },
  )
  vi.mocked(checkDuplicateTrackingNumbers).mockResolvedValue([])
  vi.mocked(createIncomingPicking).mockResolvedValue(501)
  vi.mocked(addCourierMoveWithLines).mockResolvedValue(900)
  vi.mocked(validatePicking).mockResolvedValue(undefined)
  // Covers both stock.picking.read('location_id'/'location_dest_id') and
  // ('state'); the mock doesn't care which fields were requested.
  vi.mocked(odooCall).mockResolvedValue(
    [{ state: 'assigned', location_id: [1, 'Vendors'], location_dest_id: [5, 'MB92/Stock'] }] as never,
  )
})

describe('syncRecepcionSession', () => {
  it('creates the picking, adds both courier batches in batch calls, and validates', async () => {
    await syncRecepcionSession('s1')

    expect(createIncomingPicking).toHaveBeenCalledWith(7, 33)
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 100, ['T1'], 1, 5)
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 101, ['T2'], 1, 5)
    expect(validatePicking).toHaveBeenCalledWith(501)
    expect(dbState.sesion.estado).toBe('sincronizada')
  })

  it('records the synced tracking numbers in one bulk upsert per batch', async () => {
    await syncRecepcionSession('s1')
    expect(recordSyncedTrackings).toHaveBeenCalledTimes(2)
    expect(recordSyncedTrackings).toHaveBeenCalledWith([{ trackingNumber: 'T1', odooPickingId: 501 }])
  })

  it('does not re-create the picking on retry (idempotent)', async () => {
    dbState.sesion.odooPickingId = 501
    await syncRecepcionSession('s1')
    expect(createIncomingPicking).not.toHaveBeenCalled()
  })

  it('checks live duplicates once for the whole session, not once per batch', async () => {
    await syncRecepcionSession('s1')
    expect(checkDuplicateTrackingNumbers).toHaveBeenCalledTimes(1)
    expect(checkDuplicateTrackingNumbers).toHaveBeenCalledWith(['T1', 'T2'])
  })

  it('excludes a live-duplicate tracking, marks it duplicado, and syncs the rest', async () => {
    vi.mocked(checkDuplicateTrackingNumbers).mockImplementation(async (tns) =>
      tns.filter((t) => t === 'T1'))

    await syncRecepcionSession('s1')

    // b1's only tracking (T1) is a live duplicate -> no move for its product (100)
    expect(addCourierMoveWithLines).not.toHaveBeenCalledWith(501, 100, expect.anything())
    // b2 is untouched by the duplicate and still syncs
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 101, ['T2'], 1, 5)
    // the offending item is marked locally, session still completes
    expect(dbState.items.find((i) => i.trackingNumber === 'T1')!.estado).toBe('duplicado')
    expect(dbState.sesion.estado).toBe('sincronizada')
  })

  it('never pushes an item already flagged duplicado at scan time', async () => {
    dbState.items[0].estado = 'duplicado'

    await syncRecepcionSession('s1')

    expect(checkDuplicateTrackingNumbers).toHaveBeenCalledWith(['T2'])
    expect(addCourierMoveWithLines).toHaveBeenCalledTimes(1)
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 101, ['T2'], 1, 5)
  })

  it('skips a batch that already has an odoo_move_id on retry', async () => {
    dbState.sesion.odooPickingId = 501
    dbState.batches[0].odooMoveId = 900
    await syncRecepcionSession('s1')
    expect(addCourierMoveWithLines).toHaveBeenCalledTimes(1)
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 101, ['T2'], 1, 5)
  })

  it('does not validate a move-less picking when every tracking is a duplicate', async () => {
    vi.mocked(checkDuplicateTrackingNumbers).mockImplementation(async (tns) => tns)

    await syncRecepcionSession('s1')

    expect(addCourierMoveWithLines).not.toHaveBeenCalled()
    expect(validatePicking).not.toHaveBeenCalled()
    // the session closes instead of failing forever, with a note for /pendientes
    expect(dbState.sesion.estado).toBe('sincronizada')
    expect(dbState.sesion.ultimoError).toMatch(/duplicados/)
  })

  it('finishes an empty session quietly, without the all-duplicates note', async () => {
    dbState.batches.length = 0
    dbState.items.length = 0

    await syncRecepcionSession('s1')

    expect(validatePicking).not.toHaveBeenCalled()
    expect(dbState.sesion.estado).toBe('sincronizada')
    expect(dbState.sesion.ultimoError).toBeNull()
  })

  it('throws a readable error when the picking no longer exists in Odoo', async () => {
    vi.mocked(odooCall).mockResolvedValue([] as never)
    await expect(syncRecepcionSession('s1')).rejects.toThrow(/no existe en Odoo/)
  })
})
