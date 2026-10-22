import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => ({ odooCall: vi.fn() }))
import { odooCall } from './client'
import { fetchAlmacenes, fetchBarcos, fetchCouriers, fetchUsoCouriers } from './maestros'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('fetchAlmacenes', () => {
  it('maps each warehouse to its reception and delivery types', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { id: 1, code: 'MB92', name: 'MB92 - Barcelona', in_type_id: [1, 'x'], out_type_id: [2, 'y'] },
    ])

    expect(await fetchAlmacenes()).toEqual([
      { warehouseId: 1, codigo: 'MB92', nombre: 'MB92 - Barcelona', inTypeId: 1, outTypeId: 2 },
    ])
    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(odooCall).toHaveBeenCalledWith('stock.warehouse', 'search_read', {
      domain: [],
      fields: ['code', 'name', 'in_type_id', 'out_type_id'],
    })
  })

  it('leaves out a warehouse that has no reception or no delivery type', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { id: 1, code: 'MB92', name: 'MB92 - Barcelona', in_type_id: [1, 'x'], out_type_id: [2, 'y'] },
      { id: 9, code: 'SININ', name: 'Sin recepción', in_type_id: false, out_type_id: [18, 'y'] },
      { id: 10, code: 'SINOUT', name: 'Sin entrega', in_type_id: [17, 'x'], out_type_id: false },
    ])

    expect((await fetchAlmacenes()).map((a) => a.codigo)).toEqual(['MB92'])
  })
})

describe('fetchCouriers', () => {
  it('reads only serial-tracked products', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { id: 11, name: 'DHL' },
      { id: 69, name: 'Chronopost' },
    ])

    expect(await fetchCouriers()).toEqual([
      { productId: 11, nombre: 'DHL' },
      { productId: 69, nombre: 'Chronopost' },
    ])
    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(odooCall).toHaveBeenCalledWith('product.product', 'search_read', {
      domain: [['tracking', '=', 'serial']],
      fields: ['name'],
    })
  })
})

describe('fetchUsoCouriers', () => {
  it('counts done incoming lines per reception type and product since a date', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { product_id: [11, 'DHL'], picking_type_id: [1, 'x'] },
      { product_id: [11, 'DHL'], picking_type_id: [1, 'x'] },
      { product_id: [69, 'Chronopost'], picking_type_id: [9, 'y'] },
      { product_id: [11, 'DHL'], picking_type_id: [9, 'y'] }, // same courier in another almacén: counted apart
    ])

    const uso = await fetchUsoCouriers(new Date('2026-07-24T00:00:00Z'))

    expect(uso).toHaveLength(3)
    expect(uso).toEqual(expect.arrayContaining([
      { inTypeId: 1, productId: 11, usos: 2 },
      { inTypeId: 9, productId: 69, usos: 1 },
      { inTypeId: 9, productId: 11, usos: 1 },
    ]))
    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'search_read', {
      domain: [
        ['picking_code', '=', 'incoming'],
        ['state', '=', 'done'],
        ['date', '>=', '2026-07-24 00:00:00'],
      ],
      fields: ['product_id', 'picking_type_id'],
    })
  })

  it('ignores lines that have no product or no operation type', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { product_id: [11, 'DHL'], picking_type_id: [1, 'x'] },
      { product_id: false, picking_type_id: [1, 'x'] },
      { product_id: [11, 'DHL'], picking_type_id: false },
    ])

    expect(await fetchUsoCouriers(new Date('2026-07-24T00:00:00Z'))).toEqual([
      { inTypeId: 1, productId: 11, usos: 1 },
    ])
  })

  it('returns an empty list when there were no receptions', async () => {
    vi.mocked(odooCall).mockResolvedValue([])
    expect(await fetchUsoCouriers(new Date('2026-07-24T00:00:00Z'))).toEqual([])
  })
})

describe('fetchBarcos', () => {
  it('reads every project as a barco', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { id: 673, name: 'MAYANQUEEN' },
      { id: 942, name: 'H3' },
    ])

    expect(await fetchBarcos()).toEqual([
      { odooId: 673, nombre: 'MAYANQUEEN' },
      { odooId: 942, nombre: 'H3' },
    ])
    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(odooCall).toHaveBeenCalledWith('project.project', 'search_read', { domain: [], fields: ['name'] })
  })
})
