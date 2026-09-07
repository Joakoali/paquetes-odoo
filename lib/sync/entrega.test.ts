import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../odoo/client', () => ({ odooCall: vi.fn() }))
vi.mock('../odoo/pickings', () => ({ validatePicking: vi.fn() }))

const dbState = {
  sesion: {
    id: 's1', odooPickingIds: [700, 701] as number[], firmaData: 'data:image/png;base64,AAA',
    estado: 'confirmada_pendiente_sync', intentos: 0,
  },
}

vi.mock('../../db/client', () => ({
  db: {
    query: { sesionesEscaneo: { findFirst: async () => dbState.sesion } },
    update: () => ({ set: (v: any) => ({ where: async () => { Object.assign(dbState.sesion, v) } }) }),
    insert: () => ({ values: async () => {} }),
  },
}))

import { odooCall } from '../odoo/client'
import { validatePicking } from '../odoo/pickings'
import { syncEntregaSession } from './entrega'

beforeEach(() => {
  vi.clearAllMocks()
  dbState.sesion.estado = 'confirmada_pendiente_sync'
  vi.mocked(validatePicking).mockResolvedValue(undefined)
})

describe('syncEntregaSession', () => {
  it('writes signature and validates each picking not already done', async () => {
    vi.mocked(odooCall).mockImplementation(async (model: string, method: string) => {
      if (model === 'stock.picking' && method === 'read') return [{ id: 700, state: 'assigned' }]
      return undefined
    })

    await syncEntregaSession('s1')

    expect(odooCall).toHaveBeenCalledWith('stock.picking', 'write', {
      ids: [700],
      vals: { signature: 'data:image/png;base64,AAA', is_signed: true },
    })
    expect(validatePicking).toHaveBeenCalledWith(700)
    expect(dbState.sesion.estado).toBe('sincronizada')
  })

  it('skips a picking already in state done', async () => {
    vi.mocked(odooCall).mockImplementation(async (model: string, method: string, params: any) => {
      if (model === 'stock.picking' && method === 'read') {
        const id = params.ids[0]
        return [{ id, state: id === 700 ? 'done' : 'assigned' }]
      }
      return undefined
    })

    await syncEntregaSession('s1')

    expect(validatePicking).not.toHaveBeenCalledWith(700)
    expect(validatePicking).toHaveBeenCalledWith(701)
  })

  it('throws a readable error when the picking no longer exists in Odoo', async () => {
    vi.mocked(odooCall).mockImplementation(async (model: string, method: string) => {
      if (model === 'stock.picking' && method === 'read') return []
      return undefined
    })

    await expect(syncEntregaSession('s1')).rejects.toThrow(/no existe en Odoo/)
    expect(validatePicking).not.toHaveBeenCalled()
  })
})
