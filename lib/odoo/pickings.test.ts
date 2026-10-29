import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./client', () => ({ odooCall: vi.fn() }))
import { odooCall } from './client'
import { ConfiguracionError, RespuestaOdooInesperadaError } from '../errores'
import {
  checkDuplicateTrackingNumbers, createIncomingPicking, addCourierMoveWithLines, resumeCourierMoveWithLines, validatePicking,
  getBarcosConEntregaPendiente, getLineasEntregaPendiente, validarEntrega,
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

describe('resumeCourierMoveWithLines', () => {
  /** What the picking has for the courier: the moves it answers to, then the lines of the move. */
  function odooTiene(moves: Array<{ id: number }>, lines: Array<{ lot_name: string | false; lot_id: [number, string] | false }> = []) {
    vi.mocked(odooCall).mockImplementation(async (modelo, metodo) => {
      if (modelo === 'stock.move' && metodo === 'search_read') return moves as never
      if (modelo === 'stock.move.line' && metodo === 'search_read') return lines as never
      if (modelo === 'stock.move' && metodo === 'create') return [900] as never
      return [1, 2] as never
    })
  }
  const llamadas = (modelo: string, metodo: string) =>
    vi.mocked(odooCall).mock.calls.filter(([m, me]) => m === modelo && me === metodo).map(([, , params]) => params)

  it('asks for the moves of the courier on the picking that are not cancelled, and makes the whole move when there is none', async () => {
    odooTiene([])

    const moveId = await resumeCourierMoveWithLines(501, 15, ['T1', 'T2'], 1, 5)

    expect(moveId).toBe(900)
    expect(llamadas('stock.move', 'search_read')).toEqual([{
      domain: [['picking_id', '=', 501], ['product_id', '=', 15], ['state', '!=', 'cancel']],
      fields: ['id'],
    }])
    expect(llamadas('stock.move', 'create')).toHaveLength(1)
    expect(llamadas('stock.move.line', 'create')).toEqual([{
      vals_list: [
        { move_id: 900, picking_id: 501, product_id: 15, lot_name: 'T1', quantity: 1, picked: true },
        { move_id: 900, picking_id: 501, product_id: 15, lot_name: 'T2', quantity: 1, picked: true },
      ],
    }])
  })

  it('makes no second move when the courier has one without lines, and gives it all its lines', async () => {
    odooTiene([{ id: 880 }], [])

    const moveId = await resumeCourierMoveWithLines(501, 15, ['T1', 'T2'], 1, 5)

    expect(moveId).toBe(880)
    expect(llamadas('stock.move', 'create')).toEqual([])
    expect(llamadas('stock.move.line', 'search_read')).toEqual([{ domain: [['move_id', '=', 880]], fields: ['lot_name', 'lot_id'] }])
    expect(llamadas('stock.move.line', 'create')).toEqual([{
      vals_list: [
        { move_id: 880, picking_id: 501, product_id: 15, lot_name: 'T1', quantity: 1, picked: true },
        { move_id: 880, picking_id: 501, product_id: 15, lot_name: 'T2', quantity: 1, picked: true },
      ],
    }])
  })

  it('makes only the lines the move lacks', async () => {
    odooTiene([{ id: 880 }], [{ lot_name: 'T1', lot_id: false }])

    expect(await resumeCourierMoveWithLines(501, 15, ['T1', 'T2', 'T3'], 1, 5)).toBe(880)

    expect(llamadas('stock.move.line', 'create')).toEqual([{
      vals_list: [
        { move_id: 880, picking_id: 501, product_id: 15, lot_name: 'T2', quantity: 1, picked: true },
        { move_id: 880, picking_id: 501, product_id: 15, lot_name: 'T3', quantity: 1, picked: true },
      ],
    }])
  })

  it('makes nothing when the move has all its lines, whether they name the package by lot_name or by lot', async () => {
    odooTiene([{ id: 880 }], [{ lot_name: 'T1', lot_id: false }, { lot_name: false, lot_id: [7, 'T2'] }])

    expect(await resumeCourierMoveWithLines(501, 15, ['T1', 'T2'], 1, 5)).toBe(880)

    expect(llamadas('stock.move', 'create')).toEqual([])
    expect(llamadas('stock.move.line', 'create')).toEqual([])
  })

  it('throws, and makes nothing, when the picking has more than one move of the courier', async () => {
    odooTiene([{ id: 880 }, { id: 881 }])

    const err = await resumeCourierMoveWithLines(501, 15, ['T1'], 1, 5).catch((e) => e)

    expect(err).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(err.message).toBe('El albarán tiene 2 movimientos del mismo courier. Revisalo en Odoo antes de reintentar.')
    expect(llamadas('stock.move', 'create')).toEqual([])
    expect(llamadas('stock.move.line', 'create')).toEqual([])
  })
})

describe('validatePicking', () => {
  /**
   * An Odoo that answers each call of `validatePicking`: `true` to confirm and assign, `alValidar` to
   * `button_validate`, and `estado` when the state of the picking is read afterwards (null: no such picking).
   */
  function odooResponde(alValidar: unknown, estado: string | null = null) {
    vi.mocked(odooCall).mockImplementation((async (_modelo: string, metodo: string) => {
      if (metodo === 'button_validate') return alValidar
      if (metodo === 'read') return estado === null ? [] : [{ id: 501, state: estado }]
      return true
    }) as never)
  }

  it('runs confirm, assign, and validate in sequence', async () => {
    vi.mocked(odooCall).mockResolvedValue(true)

    await validatePicking(501)

    expect(odooCall).toHaveBeenNthCalledWith(1, 'stock.picking', 'action_confirm', { ids: [501] })
    expect(odooCall).toHaveBeenNthCalledWith(2, 'stock.picking', 'action_assign', { ids: [501] })
    expect(odooCall).toHaveBeenNthCalledWith(3, 'stock.picking', 'button_validate', { ids: [501] })
  })

  it('makes no call beyond the validation when Odoo answers true: the picking is done and there is nothing to ask', async () => {
    odooResponde(true)

    await validatePicking(501)

    expect(vi.mocked(odooCall).mock.calls.map(([, metodo]) => metodo)).toEqual(['action_confirm', 'action_assign', 'button_validate'])
  })

  // `button_validate` can finish `_action_done` and still answer with an action instead of `true`: a report to print
  // (`auto_print_*` on the operation type), or the reception report. The picking is already done by then.
  it.each([
    ['a report to print', { type: 'ir.actions.client', tag: 'do_multi_print' }],
    ['the reception report', { type: 'ir.actions.report', report_name: 'stock.report_reception' }],
    ['a window action', { type: 'ir.actions.act_window', res_model: 'stock.picking', res_id: 501 }],
  ])('counts the validation as done when Odoo answers with %s and the picking is done', async (_caso, accion) => {
    odooResponde(accion, 'done')

    await expect(validatePicking(501)).resolves.toBeUndefined()

    // One read of the state, after the validation, and nothing else.
    expect(vi.mocked(odooCall).mock.calls.slice(3)).toEqual([['stock.picking', 'read', { ids: [501], fields: ['state'] }]])
  })

  it.each([[false], [null]])('counts the validation as done when Odoo answers %s and the picking is done', async (respuesta) => {
    odooResponde(respuesta, 'done')

    await expect(validatePicking(501)).resolves.toBeUndefined()
  })

  it('throws a RespuestaOdooInesperadaError that names the wizard when Odoo asks to confirm something instead of validating', async () => {
    odooResponde({ res_model: 'stock.backorder.confirmation' }, 'assigned')

    const err = await validatePicking(501).catch((e) => e)

    expect(err).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(err.message).toBe('Odoo pidió confirmar (stock.backorder.confirmation)')
  })

  it.each([
    ['res_model', { type: 'ir.actions.act_window', tag: 'x', res_model: 'stock.immediate.transfer' }, 'stock.immediate.transfer'],
    ['tag', { type: 'ir.actions.client', tag: 'do_multi_print' }, 'do_multi_print'],
    ['type', { type: 'ir.actions.report' }, 'ir.actions.report'],
    ['tag when res_model is false', { type: 'ir.actions.client', res_model: false, tag: 'do_multi_print' }, 'do_multi_print'],
  ])('names the action by its %s when the picking is not done, and never says undefined', async (_campo, accion, nombre) => {
    odooResponde(accion, 'assigned')

    const err = await validatePicking(501).catch((e) => e)

    expect(err).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(err.message).toBe(`Odoo pidió confirmar (${nombre})`)
    expect(err.message).not.toContain('undefined')
  })

  it('throws, without naming an action, for an action that names nothing and a picking that is not done', async () => {
    odooResponde({}, 'assigned')

    const err = await validatePicking(501).catch((e) => e)

    expect(err).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(err.message).toBe('Odoo no validó el albarán.')
  })

  it.each([[false], [null], [undefined]])('throws when Odoo answers %s and the picking is not done', async (respuesta) => {
    odooResponde(respuesta, 'assigned')

    const err = await validatePicking(501).catch((e) => e)

    expect(err).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(err.message).toBe('Odoo no validó el albarán.')
  })

  it('throws when the picking can not be read back after an action', async () => {
    odooResponde({ res_model: 'stock.backorder.confirmation' }, null)

    await expect(validatePicking(501)).rejects.toBeInstanceOf(RespuestaOdooInesperadaError)
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

  it('reads every move line of the pending pickings of the barco in one request, through their picking', async () => {
    vi.mocked(odooCall).mockResolvedValueOnce([
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
    // One request and not two: odooCall spaces them 1 s apart.
    expect(odooCall).toHaveBeenCalledTimes(1)
    expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'search_read', {
      // The same domain as the list of barcos (`getBarcosConEntregaPendiente`), asked of the picking of each line.
      domain: [
        ['picking_id.picking_type_id', '=', 2],
        ['picking_id.state', 'not in', ['draft', 'done', 'cancel']],
        ['picking_id.x_studio_barco', '!=', false],
        ['picking_id.x_studio_barco', '=', 673],
      ],
      fields: ['picking_id', 'lot_id', 'product_id'],
    })
    expect(JSON.stringify(vi.mocked(odooCall).mock.calls)).not.toContain('picking_type_code')
  })

  it('returns a line without lot as trackingNumber null', async () => {
    vi.mocked(odooCall).mockResolvedValueOnce([
      { id: 8, picking_id: [1, 'MB92/OUT/00487'], lot_id: [31, 'XW2'], product_id: [11, 'DHL'] },
      { id: 9, picking_id: [1, 'MB92/OUT/00487'], lot_id: false, product_id: [21, 'UPS (incorrecto)'] },
    ])

    const lineas = await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })

    expect(lineas).toContainEqual({ moveLineId: 9, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: null, courierNombre: 'UPS (incorrecto)' })
    expect(lineas).toContainEqual({ moveLineId: 8, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: 'XW2', courierNombre: 'DHL' })
    expect(lineas).toHaveLength(2)
  })

  it('keeps a line whose product came back empty instead of leaving it out', async () => {
    vi.mocked(odooCall).mockResolvedValueOnce([{ id: 9, picking_id: [1, 'MB92/OUT/00487'], lot_id: [31, 'XW2'], product_id: false }])

    expect(await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })).toEqual([
      { moveLineId: 9, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: 'XW2', courierNombre: 'Sin producto' },
    ])
  })

  it('leaves out a move line that is in no picking', async () => {
    // The domain already rules it out; the check is for the types.
    vi.mocked(odooCall).mockResolvedValueOnce([
      { id: 8, picking_id: false, lot_id: [31, 'XW2'], product_id: [11, 'DHL'] },
      { id: 9, picking_id: [1, 'MB92/OUT/00487'], lot_id: [32, 'XW3'], product_id: [11, 'DHL'] },
    ])

    expect(await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })).toEqual([
      { moveLineId: 9, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: 'XW3', courierNombre: 'DHL' },
    ])
  })

  it('answers an empty list when the barco has no pending line, with that one request', async () => {
    vi.mocked(odooCall).mockResolvedValueOnce([])

    expect(await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })).toEqual([])
    expect(odooCall).toHaveBeenCalledTimes(1)
  })

  it('reads the barco from the field named in ODOO_FIELD_BARCO', async () => {
    vi.stubEnv('ODOO_FIELD_BARCO', 'x_studio_otro_barco')
    vi.mocked(odooCall).mockResolvedValueOnce([])

    await getLineasEntregaPendiente({ outTypeId: 2, barcoOdooId: 673 })

    expect(vi.mocked(odooCall).mock.calls[0][2]).toMatchObject({
      domain: expect.arrayContaining([['picking_id.x_studio_otro_barco', '=', 673]]),
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

describe('validarEntrega', () => {
  /**
   * An Odoo answer for each of the calls `validarEntrega` makes: the picking it reads (with `estado` as its state,
   * which is only looked at after an answer that is not `true`), and what `button_validate` returns.
   */
  function odooResponde(lineasDelPicking: number[], alValidar: unknown = true, estado = 'assigned') {
    vi.mocked(odooCall).mockImplementation((async (_modelo: string, metodo: string) => {
      if (metodo === 'read') return [{ id: 700, move_line_ids: lineasDelPicking, state: estado }]
      if (metodo === 'button_validate') return alValidar
      return true
    }) as never)
  }

  /** The calls made to Odoo, in order, as [model, method, params]. */
  const llamadas = () => vi.mocked(odooCall).mock.calls

  it('picks only the chosen lines and validates with skip_backorder when some stay', async () => {
    odooResponde([1, 2, 3])

    expect(await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1, 2] })).toEqual({ quedanEnDeposito: 1 })

    expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'write', { ids: [1, 2], vals: { picked: true } })
    expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'write', { ids: [3], vals: { picked: false } })
    expect(odooCall).toHaveBeenCalledWith('stock.picking', 'button_validate', { ids: [700], context: { skip_backorder: true } })
  })

  it('reads the lines of the picking, marks the chosen and the rest, and only then validates', async () => {
    odooResponde([1, 2, 3, 4])

    await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [2, 4] })

    // Nothing else is asked of Odoo, and in this order: the validation needs the flags in place.
    expect(llamadas()).toEqual([
      ['stock.picking', 'read', { ids: [700], fields: ['move_line_ids'] }],
      ['stock.move.line', 'write', { ids: [2, 4], vals: { picked: true } }],
      ['stock.move.line', 'write', { ids: [1, 3], vals: { picked: false } }],
      ['stock.picking', 'button_validate', { ids: [700], context: { skip_backorder: true } }],
    ])
  })

  it('validates plainly when every line is chosen: no line left unpicked and no context', async () => {
    odooResponde([1, 2, 3])

    expect(await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1, 2, 3] })).toEqual({ quedanEnDeposito: 0 })

    expect(llamadas()).toEqual([
      ['stock.picking', 'read', { ids: [700], fields: ['move_line_ids'] }],
      ['stock.move.line', 'write', { ids: [1, 2, 3], vals: { picked: true } }],
      // No `context` at all: it is not a backorder, so there is nothing to skip.
      ['stock.picking', 'button_validate', { ids: [700] }],
    ])
    expect(llamadas()[2][2]).not.toHaveProperty('context')
  })

  it('counts every line it leaves unpicked as staying in depósito', async () => {
    odooResponde([1, 2, 3, 4, 5])

    expect(await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [5] })).toEqual({ quedanEnDeposito: 4 })
  })

  it('throws when Odoo answers with a wizard instead of true and the picking is not done: a RespuestaOdooInesperadaError that names it', async () => {
    odooResponde([1, 2], {
      type: 'ir.actions.act_window',
      res_model: 'stock.backorder.confirmation',
      view_mode: 'form',
      target: 'new',
    })

    const error = await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1] }).catch((e) => e)

    expect(error).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(error.message).toBe('Odoo pidió confirmar (stock.backorder.confirmation)')
  })

  it('throws for the backorder wizard that skip_backorder was meant to avoid, as it did before: nothing was validated', async () => {
    odooResponde([1, 2, 3], { type: 'ir.actions.act_window', res_model: 'stock.backorder.confirmation' }, 'assigned')

    const error = await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1] }).catch((e) => e)

    expect(error).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(error.message).toBe('Odoo pidió confirmar (stock.backorder.confirmation)')
    // It validated with skip_backorder, as ever, and only read the state afterwards.
    expect(llamadas().map(([, metodo]) => metodo)).toEqual(['read', 'write', 'write', 'button_validate', 'read'])
  })

  it('also throws for a wizard when it validates plainly', async () => {
    odooResponde([1], { type: 'ir.actions.act_window', res_model: 'stock.immediate.transfer' })

    const error = await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1] }).catch((e) => e)

    expect(error).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(error.message).toBe('Odoo pidió confirmar (stock.immediate.transfer)')
  })

  it('does not take a chosen line that is not on the picking for one of its own', async () => {
    odooResponde([1, 2, 3])

    // 99 is on some other delivery: the picking is not the place to mark it, nor to count it.
    expect(await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [2, 99] })).toEqual({ quedanEnDeposito: 2 })

    expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'write', { ids: [2], vals: { picked: true } })
    expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'write', { ids: [1, 3], vals: { picked: false } })
    expect(JSON.stringify(llamadas())).not.toContain('99')
  })

  it('validates nothing when none of the chosen lines is on the picking', async () => {
    // With every line unpicked Odoo could take that as "deliver it all": it must not get that far.
    odooResponde([1, 2, 3])

    await expect(validarEntrega({ pickingId: 700, moveLineIdsElegidas: [98, 99] })).rejects.toThrow('Ninguna de las líneas elegidas está en el picking 700')

    expect(llamadas()).toHaveLength(1) // the read
  })

  it('throws a readable error, before touching anything, when the picking no longer exists in Odoo', async () => {
    vi.mocked(odooCall).mockResolvedValue([])

    await expect(validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1] })).rejects.toThrow('picking 700 no existe en Odoo')

    expect(llamadas()).toHaveLength(1)
  })

  it('does not validate when marking the lines fails', async () => {
    vi.mocked(odooCall).mockResolvedValueOnce([{ id: 700, move_line_ids: [1, 2] }]).mockRejectedValueOnce(new Error('Odoo se cayó'))

    await expect(validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1] })).rejects.toThrow('Odoo se cayó')

    expect(llamadas().map(([, metodo]) => metodo)).toEqual(['read', 'write'])
  })

  // `auto_print_delivery_slip` is common on the delivery types: Odoo finishes the validation and answers with the
  // action that prints the slip. The picking is done by then, and the lines it delivered are on it.
  it.each([
    ['with some lines staying', [1, 2, 3], [1, 2], 1, { context: { skip_backorder: true } }],
    ['with every line chosen', [1, 2], [1, 2], 0, {}],
  ])('counts the delivery as validated when Odoo answers with a report to print and the picking is done, %s', async (_caso, lineas, elegidas, quedan, contexto) => {
    odooResponde(lineas, { type: 'ir.actions.client', tag: 'do_multi_print' }, 'done')

    expect(await validarEntrega({ pickingId: 700, moveLineIdsElegidas: elegidas })).toEqual({ quedanEnDeposito: quedan })

    // The validation is what it always is; the only thing added is one read of the state after it.
    const metodos = llamadas().map(([, metodo]) => metodo)
    expect(metodos.slice(-2)).toEqual(['button_validate', 'read'])
    expect(llamadas().at(-2)).toEqual(['stock.picking', 'button_validate', { ids: [700], ...contexto }])
    expect(llamadas().at(-1)).toEqual(['stock.picking', 'read', { ids: [700], fields: ['state'] }])
  })

  it('makes no read after the validation when Odoo answers true', async () => {
    odooResponde([1, 2])

    await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1, 2] })

    expect(llamadas().filter(([, metodo]) => metodo === 'read')).toHaveLength(1) // the one before marking the lines
    expect(llamadas().at(-1)?.[1]).toBe('button_validate')
  })

  it.each([
    ['a report to print', { type: 'ir.actions.client', tag: 'do_multi_print' }, 'do_multi_print'],
    ['an action with no model nor tag', { type: 'ir.actions.report' }, 'ir.actions.report'],
  ])('throws, naming the action and never saying undefined, when Odoo answers with %s and the picking is not done', async (_caso, accion, nombre) => {
    odooResponde([1, 2], accion, 'assigned')

    const error = await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1] }).catch((e) => e)

    expect(error).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(error.message).toBe(`Odoo pidió confirmar (${nombre})`)
  })

  it('throws when Odoo answers false and the picking is not done, and counts it as validated when it is done', async () => {
    odooResponde([1], false, 'assigned')
    const error = await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1] }).catch((e) => e)
    expect(error).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(error.message).toBe('Odoo no validó el albarán.')

    odooResponde([1], false, 'done')
    expect(await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1] })).toEqual({ quedanEnDeposito: 0 })
  })
})
