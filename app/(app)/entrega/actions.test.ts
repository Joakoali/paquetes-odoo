import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn().mockReturnValue({ value: 'mock-token' })
  })
}))
vi.mock('../../../lib/auth/guards', () => ({ requireOperario: vi.fn().mockResolvedValue({ id: 'op-1' }) }))
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

import { getPendingOutgoing } from '../../../lib/odoo/pickings'
import { publishSync } from '../../../lib/queue/publish'
import { loadPendingDeliveries, confirmEntregaSession } from './actions'

beforeEach(() => { state.sesiones.length = 0 })

describe('entrega actions', () => {
  it('loadPendingDeliveries reads via the almacen picking_type_id', async () => {
    vi.mocked(getPendingOutgoing).mockResolvedValue([{ id: 700, name: 'X', trackingNumbers: ['T1'] }])
    const result = await loadPendingDeliveries(1, 33)
    expect(getPendingOutgoing).toHaveBeenCalledWith(7, 33)
    expect(result).toHaveLength(1)
  })

  it('confirmEntregaSession creates a sesion and publishes to sync', async () => {
    const id = await confirmEntregaSession(1, 33, [700], 'data:image/png;base64,AAA')
    expect(id).toBe('s1')
    expect(state.sesiones[0]).toMatchObject({
      tipo: 'entrega', odooPickingIds: [700], firmaData: 'data:image/png;base64,AAA',
      estado: 'confirmada_pendiente_sync',
    })
    expect(publishSync).toHaveBeenCalledWith({ sesionId: 's1' })
  })
})
