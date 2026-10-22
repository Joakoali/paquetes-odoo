import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => ({ odooCall: vi.fn() }))
import { odooCall } from './client'
import { fetchAlmacenes, fetchBarcos, fetchCouriers, fetchLineasConTracking, fetchUsoCouriers } from './maestros'

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

describe('fetchLineasConTracking', () => {
  it('reads one page of tracking numbers with the picking each one is in', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { lot_id: [501, 'JJD1'], picking_id: [9, 'MB92/IN/00198'], picking_code: 'incoming' },
      { lot_id: [502, 'XW2'], picking_id: [12, 'MB92/OUT/00045'], picking_code: 'outgoing' },
    ])

    expect(await fetchLineasConTracking({ offset: 2000, limit: 2000 })).toEqual([
      { trackingNumber: 'JJD1', pickingId: 9, pickingRef: 'MB92/IN/00198', esRecepcion: true },
      { trackingNumber: 'XW2', pickingId: 12, pickingRef: 'MB92/OUT/00045', esRecepcion: false },
    ])
    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'search_read', {
      domain: [
        ['lot_id', '!=', false],
        ['state', '!=', 'cancel'],
        // Lines in no picking are left out by Odoo, so a page is as long as Odoo's page.
        ['picking_id', '!=', false],
      ],
      fields: ['lot_id', 'picking_id', 'picking_code'],
      order: 'id',
      offset: 2000,
      limit: 2000,
    })
  })

  it('passes the page it is given to Odoo', async () => {
    vi.mocked(odooCall).mockResolvedValue([])

    await fetchLineasConTracking({ offset: 0, limit: 50 })

    expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'search_read', expect.objectContaining({ offset: 0, limit: 50 }))
  })

  it('counts as a reception only a picking of the incoming type', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { lot_id: [1, 'A'], picking_id: [10, 'MB92/IN/00001'], picking_code: 'incoming' },
      { lot_id: [2, 'B'], picking_id: [11, 'MB92/OUT/00001'], picking_code: 'outgoing' },
      { lot_id: [3, 'C'], picking_id: [12, 'MB92/INT/00001'], picking_code: 'internal' },
      { lot_id: [4, 'D'], picking_id: [13, 'MB92/XX/00001'], picking_code: false },
    ])

    const lineas = await fetchLineasConTracking({ offset: 0, limit: 2000 })

    expect(lineas.map((l) => [l.trackingNumber, l.esRecepcion])).toEqual([
      ['A', true], ['B', false], ['C', false], ['D', false],
    ])
  })

  it('skips a line that has no lot or no picking', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { lot_id: [1, 'A'], picking_id: [10, 'MB92/IN/00001'], picking_code: 'incoming' },
      { lot_id: false, picking_id: [10, 'MB92/IN/00001'], picking_code: 'incoming' },
      { lot_id: [3, 'C'], picking_id: false, picking_code: false },
    ])

    expect((await fetchLineasConTracking({ offset: 0, limit: 2000 })).map((l) => l.trackingNumber)).toEqual(['A'])
  })

  it('returns an empty list when the page is empty', async () => {
    vi.mocked(odooCall).mockResolvedValue([])
    expect(await fetchLineasConTracking({ offset: 4000, limit: 2000 })).toEqual([])
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
