import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/auth/current-operario', () => ({
  requireOperarioFromCookies: vi.fn().mockResolvedValue({ id: 'op-1' }),
}))
vi.mock('../../../lib/admin/operarioAlmacenes', () => ({
  operarioHasAlmacen: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../../lib/odoo/pickings', () => ({ getPendingOutgoing: vi.fn() }))
vi.mock('../../../lib/queue/publish', () => ({ publishSync: vi.fn() }))

const state = { almacen: { id: 1, odooPickingTypeId: 7 }, sesiones: [] as any[] }
vi.mock('../../../db/client', () => ({
  db: {
    query: { almacenes: { findFirst: async () => state.almacen } },
    insert: () => ({
      values: (v: any) => ({
        returning: async () => { const row = { id: 's1', ...v }; state.sesiones.push(row); return [row] },
      }),
    }),
  },
}))

import { operarioHasAlmacen } from '../../../lib/admin/operarioAlmacenes'
import { getPendingOutgoing } from '../../../lib/odoo/pickings'
import { publishSync } from '../../../lib/queue/publish'
import { loadPendingDeliveries, confirmEntregaSession } from './actions'

beforeEach(() => {
  vi.clearAllMocks()
  state.sesiones.length = 0
  vi.mocked(operarioHasAlmacen).mockResolvedValue(true)
})

describe('entrega actions', () => {
  it('loadPendingDeliveries reads via the almacen picking_type_id', async () => {
    vi.mocked(getPendingOutgoing).mockResolvedValue([{ id: 700, name: 'X', trackingNumbers: ['T1'] }])
    const result = await loadPendingDeliveries(1, 33)
    expect(getPendingOutgoing).toHaveBeenCalledWith(7, 33)
    expect(result).toHaveLength(1)
  })

  it('loadPendingDeliveries rejects an almacen the operario is not assigned to', async () => {
    vi.mocked(operarioHasAlmacen).mockResolvedValue(false)
    await expect(loadPendingDeliveries(9, 33)).rejects.toThrow(/almacén 9/)
    expect(getPendingOutgoing).not.toHaveBeenCalled()
  })

  it('confirmEntregaSession creates a sesion and publishes to sync', async () => {
    const id = await confirmEntregaSession(1, 33, [700], 'data:image/png;base64,AAA')
    expect(id).toBe('s1')
    expect(state.sesiones[0]).toMatchObject({
      tipo: 'entrega', odooPickingIds: [700],
      estado: 'confirmada_pendiente_sync',
    })
    expect(publishSync).toHaveBeenCalledWith({ sesionId: 's1' })
  })

  it('confirmEntregaSession stores bare base64, stripping the data-URI prefix', async () => {
    await confirmEntregaSession(1, 33, [700], 'data:image/png;base64,AAA')
    expect(state.sesiones[0].firmaData).toBe('AAA')
  })

  it('confirmEntregaSession leaves an already-bare base64 signature untouched', async () => {
    await confirmEntregaSession(1, 33, [700], 'AAA')
    expect(state.sesiones[0].firmaData).toBe('AAA')
  })

  it('confirmEntregaSession rejects an almacen the operario is not assigned to', async () => {
    vi.mocked(operarioHasAlmacen).mockResolvedValue(false)
    await expect(confirmEntregaSession(9, 33, [700], 'AAA')).rejects.toThrow(/almacén 9/)
    expect(state.sesiones).toHaveLength(0)
  })
})
