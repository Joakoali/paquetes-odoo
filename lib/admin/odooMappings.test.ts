import { describe, it, expect, vi, beforeEach } from 'vitest'

const almacenRows = [{ id: 1, odooPickingTypeId: null as number | null }]
const courierRows = [{ id: 1, odooProductId: null as number | null }]

vi.mock('../../db/client', () => ({
  db: {
    update: (table: any) => ({
      set: (v: any) => ({
        where: async () => {
          const target = table === 'almacenes' ? almacenRows[0] : courierRows[0]
          Object.assign(target, v)
        },
      }),
    }),
  },
}))
vi.mock('../../db/schema', () => ({ almacenes: 'almacenes', couriers: 'couriers' }))

import { setAlmacenOdooPickingTypeId, setCourierOdooProductId } from './odooMappings'

beforeEach(() => {
  almacenRows[0].odooPickingTypeId = null
  courierRows[0].odooProductId = null
})

describe('odoo mappings', () => {
  it('sets the picking type id for an almacen', async () => {
    await setAlmacenOdooPickingTypeId(1, 42)
    expect(almacenRows[0].odooPickingTypeId).toBe(42)
  })

  it('sets the product id for a courier', async () => {
    await setCourierOdooProductId(1, 99)
    expect(courierRows[0].odooProductId).toBe(99)
  })
})
