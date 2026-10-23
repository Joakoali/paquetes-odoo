import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./client', () => ({ odooCall: vi.fn() }))
import { odooCall } from './client'
import { ConfiguracionError } from '../errores'
import { checkDuplicateTrackingNumbers, createIncomingPicking, addCourierMoveWithLines, validatePicking, getPendingOutgoing } from './pickings'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('checkDuplicateTrackingNumbers', () => {
  it('returns the picking of each tracking number already present in Odoo, via one call', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { lot_id: [10, 'ABC123'], picking_id: [100, 'MB92/IN/00010'] },
      { lot_id: [11, 'XYZ789'], picking_id: [101, 'MB92/IN/00011'] },
    ])

    const result = await checkDuplicateTrackingNumbers(['ABC123', 'DEF456', 'XYZ789'])

    expect(result).toEqual(new Map([['ABC123', 'MB92/IN/00010'], ['XYZ789', 'MB92/IN/00011']]))
    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'search_read', {
      domain: [
        ['lot_id.name', 'in', ['ABC123', 'DEF456', 'XYZ789']],
        ['state', '!=', 'cancel'],
      ],
      fields: ['lot_id', 'picking_id'],
    })
  })

  it('does not call Odoo when there is nothing to look for', async () => {
    expect(await checkDuplicateTrackingNumbers([])).toEqual(new Map())
    expect(odooCall).not.toHaveBeenCalled()
  })

  it('leaves out the tracking numbers Odoo has no line with a lot for', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { lot_id: false, picking_id: [100, 'MB92/IN/00010'] },
      { lot_id: [11, 'XYZ789'], picking_id: [101, 'MB92/IN/00011'] },
    ])

    expect(await checkDuplicateTrackingNumbers(['ABC123', 'XYZ789'])).toEqual(new Map([['XYZ789', 'MB92/IN/00011']]))
  })

  it('names the first picking when a tracking number is on lines of two (the reception and the delivery that took it out)', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { lot_id: [10, 'ABC123'], picking_id: [100, 'MB92/IN/00010'] },
      { lot_id: [10, 'ABC123'], picking_id: [200, 'MB92/OUT/00020'] },
    ])

    expect(await checkDuplicateTrackingNumbers(['ABC123'])).toEqual(new Map([['ABC123', 'MB92/IN/00010']]))
  })

  it('still reports a tracking number whose only line is in no picking (an inventory adjustment)', async () => {
    vi.mocked(odooCall).mockResolvedValue([{ lot_id: [10, 'ABC123'], picking_id: false }])

    expect(await checkDuplicateTrackingNumbers(['ABC123'])).toEqual(new Map([['ABC123', 'Odoo (sin albarán)']]))
  })

  it('prefers a line in a picking to one in no picking, whichever comes first', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { lot_id: [10, 'ABC123'], picking_id: false },
      { lot_id: [10, 'ABC123'], picking_id: [100, 'MB92/IN/00010'] },
      { lot_id: [11, 'XYZ789'], picking_id: [101, 'MB92/IN/00011'] },
      { lot_id: [11, 'XYZ789'], picking_id: false },
    ])

    expect(await checkDuplicateTrackingNumbers(['ABC123', 'XYZ789'])).toEqual(
      new Map([['ABC123', 'MB92/IN/00010'], ['XYZ789', 'MB92/IN/00011']]),
    )
  })
})

describe('createIncomingPicking', () => {
  it('creates a picking with the barco custom field and picking type, in one call', async () => {
    process.env.ODOO_FIELD_BARCO = 'x_studio_barco'
    vi.mocked(odooCall).mockResolvedValue([501])

    const id = await createIncomingPicking(7, 33)

    expect(id).toBe(501)
    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(odooCall).toHaveBeenCalledWith('stock.picking', 'create', {
      vals_list: [{ picking_type_id: 7, x_studio_barco: 33 }],
    })
  })

  it('also accepts a scalar id from create', async () => {
    process.env.ODOO_FIELD_BARCO = 'x_studio_barco'
    vi.mocked(odooCall).mockResolvedValue(777)
    expect(await createIncomingPicking(7, 33)).toBe(777)
  })

  it('throws ConfiguracionError without calling Odoo when ODOO_FIELD_BARCO is not set', async () => {
    vi.stubEnv('ODOO_FIELD_BARCO', undefined)

    const err = await createIncomingPicking(7, 33).catch((e) => e)

    expect(err).toBeInstanceOf(ConfiguracionError)
    expect(err.message).toBe('ODOO_FIELD_BARCO no está configurado')
    expect(odooCall).not.toHaveBeenCalled()
  })
})

describe('addCourierMoveWithLines', () => {
  it('creates one move and one batch move.line call for all tracking numbers', async () => {
    vi.mocked(odooCall)
      .mockResolvedValueOnce([900]) // move create
      .mockResolvedValueOnce([1, 2]) // move.line create (batch)

    const moveId = await addCourierMoveWithLines(501, 15, ['T1', 'T2'], 1, 5)

    expect(moveId).toBe(900)
    expect(odooCall).toHaveBeenNthCalledWith(1, 'stock.move', 'create', {
      vals_list: [{
        picking_id: 501,
        product_id: 15,
        product_uom_qty: 2,
        description_picking: 'Recepción webapp',
        location_id: 1,
        location_dest_id: 5,
        picked: true,
      }],
    })
    expect(odooCall).toHaveBeenNthCalledWith(2, 'stock.move.line', 'create', {
      vals_list: [
        { move_id: 900, picking_id: 501, product_id: 15, lot_name: 'T1', quantity: 1, picked: true },
        { move_id: 900, picking_id: 501, product_id: 15, lot_name: 'T2', quantity: 1, picked: true },
      ],
    })
  })
})

describe('validatePicking', () => {
  it('runs confirm, assign, and validate in sequence', async () => {
    vi.mocked(odooCall).mockResolvedValue(true)

    await validatePicking(501)

    expect(odooCall).toHaveBeenNthCalledWith(1, 'stock.picking', 'action_confirm', { ids: [501] })
    expect(odooCall).toHaveBeenNthCalledWith(2, 'stock.picking', 'action_assign', { ids: [501] })
    expect(odooCall).toHaveBeenNthCalledWith(3, 'stock.picking', 'button_validate', { ids: [501] })
  })
})

describe('getPendingOutgoing', () => {
  it('reads outgoing pickings for a barco+almacen with their tracking numbers', async () => {
    process.env.ODOO_FIELD_BARCO = 'x_studio_barco'
    vi.mocked(odooCall)
      .mockResolvedValueOnce([{ id: 700, name: 'MB92/OUT/00069' }])
      .mockResolvedValueOnce([
        { picking_id: [700, 'MB92/OUT/00069'], lot_id: [1, 'T1'] },
        { picking_id: [700, 'MB92/OUT/00069'], lot_id: [2, 'T2'] },
      ])

    const result = await getPendingOutgoing(7, 33)

    expect(result).toEqual([{ id: 700, name: 'MB92/OUT/00069', trackingNumbers: ['T1', 'T2'] }])
    expect(odooCall).toHaveBeenCalledTimes(2)
  })

  it('throws ConfiguracionError without calling Odoo when ODOO_FIELD_BARCO is not set', async () => {
    vi.stubEnv('ODOO_FIELD_BARCO', undefined)

    const err = await getPendingOutgoing(7, 33).catch((e) => e)

    expect(err).toBeInstanceOf(ConfiguracionError)
    expect(err.message).toBe('ODOO_FIELD_BARCO no está configurado')
    expect(odooCall).not.toHaveBeenCalled()
  })
})
