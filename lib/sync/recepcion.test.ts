import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../odoo/pickings', () => ({
  checkDuplicateTrackingNumbers: vi.fn(),
  createIncomingPicking: vi.fn(),
  addCourierMoveWithLines: vi.fn(),
  validatePicking: vi.fn(),
}))
vi.mock('../odoo/client', () => ({ callKw: vi.fn() }))
vi.mock('../cache/trackingActivos', () => ({ recordSyncedTracking: vi.fn() }))

const dbState = {
  sesion: {
    id: 's1', almacenId: 1, barcoOdooId: 33, odooPickingId: null as number | null,
    estado: 'confirmada_pendiente_sync', intentos: 0,
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

vi.mock('../../db/client', () => ({
  db: {
    query: {
      sesionesEscaneo: { findFirst: async () => dbState.sesion },
      almacenes: { findFirst: async () => dbState.almacen },
      sesionCourierBatches: { findMany: async ({ where }: any) =>
        dbState.batches.filter((b) => where(b, { eq: (a: any, b2: any) => a === b2 })) },
      couriers: { findFirst: async ({ where }: any) => {
        const id = Object.keys(dbState.courierProductIds).find((k) =>
          where({ id: Number(k) }, { eq: (a: any, b2: any) => a === b2 }))
        return id ? { id: Number(id), odooProductId: dbState.courierProductIds[Number(id)] } : undefined
      } },
      sesionItems: { findMany: async ({ where }: any) =>
        dbState.items.filter((i) => where(i, { eq: (a: any, b2: any) => a === b2 })) },
    },
    // Best-effort: pull every string literal out of the drizzle where-expression
    // so an update scoped to a sesion_items row can be routed to that item.
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
          const matched = dbState.items.filter((i) => vals.has(i.trackingNumber) && vals.has(i.courierBatchId))
          if (matched.length > 0) {
            for (const i of matched) Object.assign(i, v)
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
import { callKw } from '../odoo/client'
import { syncRecepcionSession } from './recepcion'

beforeEach(() => {
  vi.clearAllMocks()
  dbState.sesion.odooPickingId = null
  dbState.sesion.estado = 'confirmada_pendiente_sync'
  dbState.batches[0].odooMoveId = null
  dbState.batches[1].odooMoveId = null
  dbState.items[0].estado = 'ok'
  dbState.items[1].estado = 'ok'
  vi.mocked(checkDuplicateTrackingNumbers).mockResolvedValue([])
  vi.mocked(createIncomingPicking).mockResolvedValue(501)
  vi.mocked(addCourierMoveWithLines).mockResolvedValue(900)
  vi.mocked(validatePicking).mockResolvedValue(undefined)
  // stock.picking.read('state') returns a non-terminal state by default.
  vi.mocked(callKw).mockResolvedValue([{ state: 'assigned' }] as never)
})

describe('syncRecepcionSession', () => {
  it('creates the picking, adds both courier batches in batch calls, and validates', async () => {
    await syncRecepcionSession('s1')

    expect(createIncomingPicking).toHaveBeenCalledWith(7, 33)
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 100, ['T1'])
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 101, ['T2'])
    expect(validatePicking).toHaveBeenCalledWith(501)
    expect(dbState.sesion.estado).toBe('sincronizada')
  })

  it('does not re-create the picking on retry (idempotent)', async () => {
    dbState.sesion.odooPickingId = 501
    await syncRecepcionSession('s1')
    expect(createIncomingPicking).not.toHaveBeenCalled()
  })

  it('excludes a live-duplicate tracking, marks it duplicado, and syncs the rest', async () => {
    vi.mocked(checkDuplicateTrackingNumbers).mockImplementation(async (tns) =>
      tns.filter((t) => t === 'T1'))

    await syncRecepcionSession('s1')

    // b1's only tracking (T1) is a live duplicate -> no move for its product (100)
    expect(addCourierMoveWithLines).not.toHaveBeenCalledWith(501, 100, expect.anything())
    // b2 is untouched by the duplicate and still syncs
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 101, ['T2'])
    // the offending item is marked locally, session still completes
    expect(dbState.items.find((i) => i.trackingNumber === 'T1')!.estado).toBe('duplicado')
    expect(dbState.sesion.estado).toBe('sincronizada')
  })

  it('skips a batch that already has an odoo_move_id on retry', async () => {
    dbState.sesion.odooPickingId = 501
    dbState.batches[0].odooMoveId = 900
    await syncRecepcionSession('s1')
    expect(addCourierMoveWithLines).toHaveBeenCalledTimes(1)
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 101, ['T2'])
  })
})
