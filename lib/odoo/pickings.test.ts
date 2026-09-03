import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => ({ callKw: vi.fn() }))
import { callKw } from './client'
import { checkDuplicateTrackingNumbers, createIncomingPicking, addCourierMoveWithLines, validatePicking, getPendingOutgoing } from './pickings'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('checkDuplicateTrackingNumbers', () => {
  it('returns the tracking numbers already present in Odoo, via one call', async () => {
    vi.mocked(callKw).mockResolvedValue([
      { lot_id: [10, 'ABC123'] },
      { lot_id: [11, 'XYZ789'] },
    ])

    const result = await checkDuplicateTrackingNumbers(['ABC123', 'DEF456', 'XYZ789'])

    expect(result).toEqual(['ABC123', 'XYZ789'])
    expect(callKw).toHaveBeenCalledTimes(1)
    expect(callKw).toHaveBeenCalledWith(
      'stock.move.line',
      'search_read',
      [[
        ['lot_id.name', 'in', ['ABC123', 'DEF456', 'XYZ789']],
        ['state', '!=', 'cancel'],
      ]],
      { fields: ['lot_id'] },
    )
  })
})

describe('createIncomingPicking', () => {
  it('creates a picking with the barco custom field and picking type, in one call', async () => {
    process.env.ODOO_FIELD_BARCO = 'x_studio_barco'
    vi.mocked(callKw).mockResolvedValue(501)

    const id = await createIncomingPicking(7, 33)

    expect(id).toBe(501)
    expect(callKw).toHaveBeenCalledTimes(1)
    expect(callKw).toHaveBeenCalledWith('stock.picking', 'create', [{
      picking_type_id: 7,
      x_studio_barco: 33,
    }])
  })
})

describe('addCourierMoveWithLines', () => {
  it('creates one move and one batch move.line call for all tracking numbers', async () => {
    vi.mocked(callKw)
      .mockResolvedValueOnce(900) // move create
      .mockResolvedValueOnce([1, 2]) // move.line create (batch)

    const moveId = await addCourierMoveWithLines(501, 15, ['T1', 'T2'])

    expect(moveId).toBe(900)
    expect(callKw).toHaveBeenNthCalledWith(1, 'stock.move', 'create', [{
      picking_id: 501,
      product_id: 15,
      product_uom_qty: 2,
      name: 'Recepción webapp',
    }])
    expect(callKw).toHaveBeenNthCalledWith(2, 'stock.move.line', 'create', [[
      { move_id: 900, picking_id: 501, product_id: 15, lot_name: 'T1', qty_done: 1 },
      { move_id: 900, picking_id: 501, product_id: 15, lot_name: 'T2', qty_done: 1 },
    ]])
  })
})

describe('validatePicking', () => {
  it('runs confirm, assign, and validate in sequence', async () => {
    vi.mocked(callKw).mockResolvedValue(true)

    await validatePicking(501)

    expect(callKw).toHaveBeenNthCalledWith(1, 'stock.picking', 'action_confirm', [[501]])
    expect(callKw).toHaveBeenNthCalledWith(2, 'stock.picking', 'action_assign', [[501]])
    expect(callKw).toHaveBeenNthCalledWith(3, 'stock.picking', 'button_validate', [[501]])
  })
})

describe('getPendingOutgoing', () => {
  it('reads outgoing pickings for a barco+almacen with their tracking numbers', async () => {
    process.env.ODOO_FIELD_BARCO = 'x_studio_barco'
    vi.mocked(callKw)
      .mockResolvedValueOnce([{ id: 700, name: 'MB92/OUT/00069' }])
      .mockResolvedValueOnce([
        { picking_id: [700, 'MB92/OUT/00069'], lot_id: [1, 'T1'] },
        { picking_id: [700, 'MB92/OUT/00069'], lot_id: [2, 'T2'] },
      ])

    const result = await getPendingOutgoing(7, 33)

    expect(result).toEqual([{ id: 700, name: 'MB92/OUT/00069', trackingNumbers: ['T1', 'T2'] }])
    expect(callKw).toHaveBeenCalledTimes(2)
  })
})
