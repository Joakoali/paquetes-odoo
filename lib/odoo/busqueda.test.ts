import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({ odooCall: vi.fn() }))
import { odooCall } from './client'
import { ConfiguracionError } from '../errores'
import { buscarEnOdoo } from './busqueda'

/** A picking as `read` answers it, the barco under the field of the environment. */
const picking = (datos: Record<string, unknown>) => ({
  name: 'MB92/IN/00231',
  state: 'done',
  picking_type_id: [1, 'MB92 - Barcelona: Recepciones'],
  picking_type_code: 'incoming',
  date_done: '2026-10-28 09:32:00',
  create_date: '2026-10-28 09:30:00',
  x_studio_barco: [673, 'MAYANQUEEN'],
  x_studio_recibido_por_2: 'Veronika',
  ...datos,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('ODOO_FIELD_BARCO', 'x_studio_barco')
  vi.stubEnv('ODOO_FIELD_RECIBIDO_POR', 'x_studio_recibido_por_2')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('buscarEnOdoo', () => {
  it('asks for the lines whose package has what was searched, by their lot or their lot name, the newest first', async () => {
    vi.mocked(odooCall).mockResolvedValueOnce([])

    await buscarEnOdoo({ buscado: '0588', limite: 51 })

    expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'search_read', {
      domain: [
        ['state', '!=', 'cancel'],
        ['picking_id', '!=', false],
        '|', ['lot_id.name', 'ilike', '0588'], ['lot_name', 'ilike', '0588'],
      ],
      fields: ['lot_id', 'lot_name', 'picking_id', 'product_id'],
      order: 'id desc',
      limit: 51,
    })
  })

  it('makes one request and no more when no line has the package', async () => {
    vi.mocked(odooCall).mockResolvedValueOnce([])

    expect(await buscarEnOdoo({ buscado: '0588', limite: 51 })).toEqual([])
    expect(odooCall).toHaveBeenCalledTimes(1)
  })

  it('reads the pickings of the lines once each, with their barco and "Recibido por", in a second request', async () => {
    vi.mocked(odooCall)
      .mockResolvedValueOnce([
        { lot_id: [30, 'JJD000390007840588'], lot_name: false, picking_id: [9, 'MB92/OUT/00487'], product_id: [11, 'DHL'] },
        { lot_id: [30, 'JJD000390007840588'], lot_name: false, picking_id: [5, 'MB92/IN/00231'], product_id: [11, 'DHL'] },
        { lot_id: [31, '1Z999AA10123450588'], lot_name: false, picking_id: [5, 'MB92/IN/00231'], product_id: [12, 'UPS'] },
      ])
      .mockResolvedValueOnce([
        { id: 5, ...picking({}) },
        { id: 9, ...picking({ name: 'MB92/OUT/00487', state: 'assigned', picking_type_id: [2, 'MB92: Entregas'], picking_type_code: 'outgoing', date_done: false, x_studio_recibido_por_2: false }) },
      ])

    const lineas = await buscarEnOdoo({ buscado: '0588', limite: 51 })

    expect(odooCall).toHaveBeenCalledTimes(2)
    expect(odooCall).toHaveBeenLastCalledWith('stock.picking', 'read', {
      ids: [9, 5],
      fields: ['name', 'state', 'picking_type_id', 'picking_type_code', 'date_done', 'create_date', 'x_studio_barco', 'x_studio_recibido_por_2'],
    })
    expect(lineas).toEqual([
      {
        trackingNumber: 'JJD000390007840588', courierNombre: 'DHL', pickingId: 9, pickingRef: 'MB92/OUT/00487', pickingTypeId: 2,
        operacion: 'entrega', hecho: false, barco: { odooId: 673, nombre: 'MAYANQUEEN' },
        // Not done: since when it has been waiting.
        fecha: new Date('2026-10-28T09:30:00Z'), recibidoPor: null,
      },
      {
        trackingNumber: 'JJD000390007840588', courierNombre: 'DHL', pickingId: 5, pickingRef: 'MB92/IN/00231', pickingTypeId: 1,
        operacion: 'recepcion', hecho: true, barco: { odooId: 673, nombre: 'MAYANQUEEN' },
        // Done: when it was.
        fecha: new Date('2026-10-28T09:32:00Z'), recibidoPor: 'Veronika',
      },
      {
        trackingNumber: '1Z999AA10123450588', courierNombre: 'UPS', pickingId: 5, pickingRef: 'MB92/IN/00231', pickingTypeId: 1,
        operacion: 'recepcion', hecho: true, barco: { odooId: 673, nombre: 'MAYANQUEEN' },
        fecha: new Date('2026-10-28T09:32:00Z'), recibidoPor: 'Veronika',
      },
    ])
  })

  it('takes the lot name of a line that is not validated yet, which has no lot', async () => {
    vi.mocked(odooCall)
      .mockResolvedValueOnce([{ lot_id: false, lot_name: 'QA-0588', picking_id: [5, 'MB92/IN/00231'], product_id: [11, 'DHL'] }])
      .mockResolvedValueOnce([{ id: 5, ...picking({ state: 'assigned', date_done: false }) }])

    const [linea] = await buscarEnOdoo({ buscado: '0588', limite: 51 })

    expect(linea).toMatchObject({ trackingNumber: 'QA-0588', operacion: 'recepcion', hecho: false })
  })

  it('says what it can of a picking with no barco yet, no operation type or one that is neither a reception nor a delivery', async () => {
    vi.mocked(odooCall)
      .mockResolvedValueOnce([{ lot_id: [30, 'JJD0588'], lot_name: false, picking_id: [7, 'MB92/INT/00004'], product_id: false }])
      .mockResolvedValueOnce([{ id: 7, ...picking({ name: 'MB92/INT/00004', picking_type_id: false, picking_type_code: 'internal', x_studio_barco: false }) }])

    const [linea] = await buscarEnOdoo({ buscado: '0588', limite: 51 })

    expect(linea).toMatchObject({ courierNombre: null, pickingTypeId: null, operacion: 'otra', barco: null })
  })

  it('leaves out a line whose picking is cancelled, or did not come back', async () => {
    vi.mocked(odooCall)
      .mockResolvedValueOnce([
        { lot_id: [30, 'JJD0588'], lot_name: false, picking_id: [5, 'MB92/IN/00231'], product_id: [11, 'DHL'] },
        { lot_id: [31, 'XW0588'], lot_name: false, picking_id: [6, 'MB92/IN/00232'], product_id: [11, 'DHL'] },
      ])
      .mockResolvedValueOnce([{ id: 5, ...picking({ state: 'cancel' }) }])

    expect(await buscarEnOdoo({ buscado: '0588', limite: 51 })).toEqual([])
  })

  it('does without "Recibido por" when its field is not configured: it does not ask for it', async () => {
    vi.stubEnv('ODOO_FIELD_RECIBIDO_POR', '')
    vi.mocked(odooCall)
      .mockResolvedValueOnce([{ lot_id: [30, 'JJD0588'], lot_name: false, picking_id: [5, 'MB92/IN/00231'], product_id: [11, 'DHL'] }])
      .mockResolvedValueOnce([{ id: 5, ...picking({}) }])

    const [linea] = await buscarEnOdoo({ buscado: '0588', limite: 51 })

    expect(vi.mocked(odooCall).mock.calls[1][2]).toEqual(expect.objectContaining({
      fields: ['name', 'state', 'picking_type_id', 'picking_type_code', 'date_done', 'create_date', 'x_studio_barco'],
    }))
    expect(linea.recibidoPor).toBeNull()
  })

  it('asks Odoo nothing without the field of the barco: it is something the admin has to set up', async () => {
    vi.stubEnv('ODOO_FIELD_BARCO', '')

    await expect(buscarEnOdoo({ buscado: '0588', limite: 51 })).rejects.toBeInstanceOf(ConfiguracionError)
    expect(odooCall).not.toHaveBeenCalled()
  })
})
