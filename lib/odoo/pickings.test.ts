import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./client', () => ({ odooCall: vi.fn() }))
import { odooCall } from './client'
import { ConfiguracionError } from '../errores'
import {
  checkDuplicateTrackingNumbers, createIncomingPicking, addCourierMoveWithLines, validatePicking,
  getBarcosConEntregaPendiente, getLineasEntregaPendiente,
} from './pickings'

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

describe('getBarcosConEntregaPendiente', () => {
  beforeEach(() => {
    vi.stubEnv('ODOO_FIELD_BARCO', 'x_studio_barco')
  })

  it('filters by the almacén delivery type and groups per barco', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { id: 1, x_studio_barco: [673, 'MAYANQUEEN'], move_line_ids: [1, 2], create_date: '2026-10-14 08:00:00' },
      { id: 2, x_studio_barco: [673, 'MAYANQUEEN'], move_line_ids: [3], create_date: '2026-10-20 08:00:00' },
    ])

    expect(await getBarcosConEntregaPendiente(2)).toEqual([
      { barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', paquetes: 3, desde: new Date('2026-10-14T08:00:00Z') },
    ])
    expect(vi.mocked(odooCall).mock.calls[0][2]).toMatchObject({ domain: expect.arrayContaining([['picking_type_id', '=', 2]]) })
    expect(JSON.stringify(vi.mocked(odooCall).mock.calls[0][2])).not.toContain('picking_type_code')
  })

  it('asks Odoo once for the pending pickings of that type that have a barco', async () => {
    vi.mocked(odooCall).mockResolvedValue([])

    await getBarcosConEntregaPendiente(2)

    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(odooCall).toHaveBeenCalledWith('stock.picking', 'search_read', {
      domain: [
        ['picking_type_id', '=', 2],
        ['state', 'not in', ['draft', 'done', 'cancel']],
        ['x_studio_barco', '!=', false],
      ],
      fields: ['x_studio_barco', 'move_line_ids', 'create_date'],
    })
  })

  it('adds up the packages of each barco and keeps its oldest date, whatever the order Odoo answers in', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { id: 1, x_studio_barco: [673, 'MAYANQUEEN'], move_line_ids: [1, 2], create_date: '2026-10-20 08:00:00' },
      { id: 2, x_studio_barco: [700, 'PAPIRUS'], move_line_ids: [4], create_date: '2026-10-18 09:30:00' },
      { id: 3, x_studio_barco: [673, 'MAYANQUEEN'], move_line_ids: [5], create_date: '2026-10-14 08:00:00' },
      { id: 4, x_studio_barco: [673, 'MAYANQUEEN'], move_line_ids: [6, 7, 8], create_date: '2026-10-16 08:00:00' },
    ])

    const barcos = await getBarcosConEntregaPendiente(2)

    expect(barcos).toHaveLength(2)
    expect(barcos).toContainEqual({ barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', paquetes: 6, desde: new Date('2026-10-14T08:00:00Z') })
    expect(barcos).toContainEqual({ barcoOdooId: 700, barcoNombre: 'PAPIRUS', paquetes: 1, desde: new Date('2026-10-18T09:30:00Z') })
  })

  it('keeps apart two barcos that have the same name', async () => {
    vi.mocked(odooCall).mockResolvedValue([
      { id: 1, x_studio_barco: [10, 'H3'], move_line_ids: [1, 2], create_date: '2026-10-14 08:00:00' },
      { id: 2, x_studio_barco: [11, 'H3'], move_line_ids: [3], create_date: '2026-10-15 08:00:00' },
    ])

    const barcos = await getBarcosConEntregaPendiente(2)

    expect(barcos).toHaveLength(2)
    expect(barcos).toContainEqual({ barcoOdooId: 10, barcoNombre: 'H3', paquetes: 2, desde: new Date('2026-10-14T08:00:00Z') })
    expect(barcos).toContainEqual({ barcoOdooId: 11, barcoNombre: 'H3', paquetes: 1, desde: new Date('2026-10-15T08:00:00Z') })
  })

  it('reads the barco from the field named in ODOO_FIELD_BARCO', async () => {
    vi.stubEnv('ODOO_FIELD_BARCO', 'x_studio_otro_barco')
    vi.mocked(odooCall).mockResolvedValue([
      { id: 1, x_studio_otro_barco: [673, 'MAYANQUEEN'], move_line_ids: [1], create_date: '2026-10-14 08:00:00' },
    ])

    expect(await getBarcosConEntregaPendiente(2)).toEqual([
      { barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', paquetes: 1, desde: new Date('2026-10-14T08:00:00Z') },
    ])
    expect(vi.mocked(odooCall).mock.calls[0][2]).toMatchObject({
      domain: expect.arrayContaining([['x_studio_otro_barco', '!=', false]]),
      fields: expect.arrayContaining(['x_studio_otro_barco']),
    })
  })

  it('leaves out a picking whose barco came back empty', async () => {
    // The domain already rules it out; the check is for the types.
    vi.mocked(odooCall).mockResolvedValue([
      { id: 1, x_studio_barco: false, move_line_ids: [1], create_date: '2026-10-14 08:00:00' },
      { id: 2, x_studio_barco: [673, 'MAYANQUEEN'], move_line_ids: [2], create_date: '2026-10-15 08:00:00' },
    ])

    expect(await getBarcosConEntregaPendiente(2)).toEqual([
      { barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', paquetes: 1, desde: new Date('2026-10-15T08:00:00Z') },
    ])
  })

  it('returns an empty list when no delivery is waiting', async () => {
    vi.mocked(odooCall).mockResolvedValue([])
    expect(await getBarcosConEntregaPendiente(2)).toEqual([])
  })

  it('throws ConfiguracionError without calling Odoo when ODOO_FIELD_BARCO is not set', async () => {
    vi.stubEnv('ODOO_FIELD_BARCO', undefined)

    const err = await getBarcosConEntregaPendiente(2).catch((e) => e)

    expect(err).toBeInstanceOf(ConfiguracionError)
    expect(err.message).toBe('ODOO_FIELD_BARCO no está configurado')
    expect(odooCall).not.toHaveBeenCalled()
  })
})

describe('getLineasEntregaPendiente', () => {
  beforeEach(() => {
    vi.stubEnv('ODOO_FIELD_BARCO', 'x_studio_barco')
  })

  it('reads the pending pickings of the barco and then every move line of them', async () => {
    vi.mocked(odooCall)
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
      .mockResolvedValueOnce([
        { id: 7, picking_id: [1, 'MB92/OUT/00487'], lot_id: [30, 'XW1'], product_id: [11, 'DHL'] },
        { id: 8, picking_id: [1, 'MB92/OUT/00487'], lot_id: [31, 'XW2'], product_id: [11, 'DHL'] },
        { id: 9, picking_id: [2, 'MB92/OUT/00501'], lot_id: [32, '1Z999'], product_id: [12, 'UPS'] },
      ])

    const lineas = await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })

    expect(lineas).toEqual([
      { moveLineId: 7, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: 'XW1', courierNombre: 'DHL' },
      { moveLineId: 8, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: 'XW2', courierNombre: 'DHL' },
      { moveLineId: 9, pickingId: 2, pickingRef: 'MB92/OUT/00501', trackingNumber: '1Z999', courierNombre: 'UPS' },
    ])
    expect(odooCall).toHaveBeenCalledTimes(2)
    expect(odooCall).toHaveBeenNthCalledWith(1, 'stock.picking', 'search_read', {
      domain: [
        ['picking_type_id', '=', 2],
        ['state', 'not in', ['draft', 'done', 'cancel']],
        ['x_studio_barco', '!=', false],
        ['x_studio_barco', '=', 673],
      ],
      fields: ['id'],
    })
    expect(odooCall).toHaveBeenNthCalledWith(2, 'stock.move.line', 'search_read', {
      domain: [['picking_id', 'in', [1, 2]]],
      fields: ['picking_id', 'lot_id', 'product_id'],
    })
    expect(JSON.stringify(vi.mocked(odooCall).mock.calls)).not.toContain('picking_type_code')
  })

  it('returns a line without lot as trackingNumber null', async () => {
    vi.mocked(odooCall)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([
        { id: 8, picking_id: [1, 'MB92/OUT/00487'], lot_id: [31, 'XW2'], product_id: [11, 'DHL'] },
        { id: 9, picking_id: [1, 'MB92/OUT/00487'], lot_id: false, product_id: [21, 'UPS (incorrecto)'] },
      ])

    const lineas = await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })

    expect(lineas).toContainEqual({ moveLineId: 9, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: null, courierNombre: 'UPS (incorrecto)' })
    expect(lineas).toContainEqual({ moveLineId: 8, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: 'XW2', courierNombre: 'DHL' })
    expect(lineas).toHaveLength(2)
  })

  it('keeps a line whose product came back empty instead of leaving it out', async () => {
    vi.mocked(odooCall)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 9, picking_id: [1, 'MB92/OUT/00487'], lot_id: [31, 'XW2'], product_id: false }])

    expect(await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })).toEqual([
      { moveLineId: 9, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: 'XW2', courierNombre: 'Sin producto' },
    ])
  })

  it('leaves out a move line that is in no picking', async () => {
    // The domain already rules it out; the check is for the types.
    vi.mocked(odooCall)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([
        { id: 8, picking_id: false, lot_id: [31, 'XW2'], product_id: [11, 'DHL'] },
        { id: 9, picking_id: [1, 'MB92/OUT/00487'], lot_id: [32, 'XW3'], product_id: [11, 'DHL'] },
      ])

    expect(await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })).toEqual([
      { moveLineId: 9, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: 'XW3', courierNombre: 'DHL' },
    ])
  })

  it('does not read any move line when the barco has no pending picking', async () => {
    vi.mocked(odooCall).mockResolvedValueOnce([])

    expect(await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })).toEqual([])
    expect(odooCall).toHaveBeenCalledTimes(1)
  })

  it('reads the barco from the field named in ODOO_FIELD_BARCO', async () => {
    vi.stubEnv('ODOO_FIELD_BARCO', 'x_studio_otro_barco')
    vi.mocked(odooCall).mockResolvedValueOnce([])

    await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })

    expect(vi.mocked(odooCall).mock.calls[0][2]).toMatchObject({
      domain: expect.arrayContaining([['x_studio_otro_barco', '=', 673]]),
    })
  })

  it('throws ConfiguracionError without calling Odoo when ODOO_FIELD_BARCO is not set', async () => {
    vi.stubEnv('ODOO_FIELD_BARCO', undefined)

    const err = await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 }).catch((e) => e)

    expect(err).toBeInstanceOf(ConfiguracionError)
    expect(err.message).toBe('ODOO_FIELD_BARCO no está configurado')
    expect(odooCall).not.toHaveBeenCalled()
  })
})
