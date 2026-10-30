import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./client', () => ({ odooCall: vi.fn() }))

import { RespuestaOdooInesperadaError } from '../errores'
import { OdooDeEntregas, TIPO_DE_ENTREGA } from '../testing/odoo-de-entregas'
import { odooCall } from './client'
import { aplicarReasignacion, entregaDestino, ORIGEN_CAMBIO_DE_BARCO, planearReasignacion, type PaqueteAMover } from './reasignacion'

const BARCO = 'x_studio_barco'
/** The barco the packages were received for by mistake, and the one they are for. */
const ORIGEN = 673
const DESTINO = 674

let odoo: OdooDeEntregas

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('ODOO_FIELD_BARCO', BARCO)
  odoo = new OdooDeEntregas(BARCO)
  vi.mocked(odooCall).mockImplementation(async (modelo, metodo, params) => odoo.responder(modelo, metodo, params) as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** The packages of these lines, each with the number the Odoo of the tests gives it (`T<line>`). */
const paquetes = (...lineas: number[]): PaqueteAMover[] => lineas.map((moveLineId) => ({ moveLineId, trackingNumber: `T${moveLineId}` }))

const planear = (lineas: PaqueteAMover[], entregasOrigenIds: number[] = []) => planearReasignacion({
  paquetes: lineas, outTypeId: TIPO_DE_ENTREGA, barcoOrigenOdooId: ORIGEN, barcoDestinoOdooId: DESTINO, entregasOrigenIds,
})

/** Plans the move of the lines and does it into delivery 800 of the destino, as the worker does. */
async function mover(lineas: PaqueteAMover[], entregasOrigenIds: number[] = []) {
  const plan = await planear(lineas, entregasOrigenIds)
  return { plan, ...(await aplicarReasignacion(plan, 800)) }
}

describe('planearReasignacion and aplicarReasignacion', () => {
  beforeEach(() => {
    odoo.entrega({ id: 700, barco: ORIGEN })
    odoo.entrega({ id: 800, barco: DESTINO })
    odoo.movimiento({ id: 900, picking: 800, lineas: [90] })
  })

  it('hands a move all of whose lines go to the other delivery whole, moves and lines in one write', async () => {
    odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2] })
    odoo.movimiento({ id: 101, picking: 700, lineas: [3] })

    const { plan } = await mover(paquetes(1, 2))

    expect(plan.movimientosEnteros).toEqual([100])
    expect(plan.particiones.size).toBe(0)
    expect(odoo.movimientosDe(800).map((movimiento) => movimiento.id)).toEqual([100, 900])
    expect(odoo.lineasDe(800).map((linea) => linea.id)).toEqual([1, 2, 90])
    expect(odoo.lineasDe(700).map((linea) => linea.id)).toEqual([3])
    expect(odoo.escriturasHechas()).toEqual([{
      modelo: 'stock.picking',
      metodo: 'write',
      params: { ids: [800], vals: { move_ids: [[4, 100]], move_line_ids: [[4, 1], [4, 2]] } },
    }])
  })

  it('splits a move only some of whose lines go on its own delivery first, and hands the new move over', async () => {
    odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2, 3], origenes: [10] })

    await mover(paquetes(2))

    // What stays, as it was, reserved: two packages asked for and two reserved.
    const [queda] = odoo.movimientosDe(700)
    expect(queda).toMatchObject({ id: 100, demanda: 2, state: 'assigned' })
    expect(odoo.cantidadDe(100)).toBe(2)
    expect(odoo.lineasDe(700).map((linea) => linea.id)).toEqual([1, 3])
    // What goes: one package, reserved, from the same line of the recepción.
    const nuevo = odoo.movimientosDe(800).find((movimiento) => movimiento.id !== 900)
    expect(nuevo).toMatchObject({ demanda: 1, state: 'assigned', origenes: [10], producto: 11 })
    expect(odoo.lineas.get(2)).toMatchObject({ picking: 800, movimiento: nuevo?.id })
  })

  it('splits with one write on the delivery of origen: the new move first, then the demand, and nothing unreserved', async () => {
    odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2, 3], origenes: [10] })

    await mover(paquetes(2))

    const [particion] = odoo.escriturasHechas()
    expect(particion).toEqual({
      modelo: 'stock.picking',
      metodo: 'write',
      params: {
        ids: [700],
        vals: {
          move_ids: [
            [0, 0, {
              company_id: 1,
              product_id: 11,
              product_uom_qty: 1,
              location_id: 8,
              location_dest_id: 5,
              picking_type_id: TIPO_DE_ENTREGA,
              procure_method: 'make_to_order',
              origin: 'MB92/IN/00231',
              move_orig_ids: [[6, 0, [10]]],
              state: 'assigned',
              move_line_ids: [[4, 2]],
            }],
            [1, 100, { product_uom_qty: 2 }],
          ],
        },
        context: { do_not_unreserve: true },
      },
    })
  })

  it('moves whole moves and split ones together, and leaves the delivery of origen with what stays', async () => {
    odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2] })
    odoo.movimiento({ id: 101, picking: 700, lineas: [3, 4, 5], producto: 12 })

    const { canceladas } = await mover(paquetes(1, 2, 4))

    expect(odoo.lineasDe(800).map((linea) => linea.id)).toEqual([1, 2, 4, 90])
    expect(odoo.lineasDe(700).map((linea) => linea.id)).toEqual([3, 5])
    expect(odoo.movimientos.get(101)).toMatchObject({ picking: 700, demanda: 2 })
    expect(odoo.estadoDe(700)).toBe('assigned')
    expect(canceladas).toEqual([])
  })

  it('cancels a delivery of origen that is left with nothing', async () => {
    odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2] })

    const { plan, canceladas } = await mover(paquetes(1, 2))

    expect(plan.aCancelar).toEqual([{ id: 700, ref: 'MB92/OUT/00700' }])
    expect(canceladas).toEqual([{ id: 700, ref: 'MB92/OUT/00700' }])
    expect(odoo.estadoDe(700)).toBe('cancel')
  })

  it('does not cancel a delivery that the cron merged a new package into since it was read', async () => {
    odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2] })
    const plan = await planear(paquetes(1, 2))
    // A recepción validated meanwhile: the cron of Odoo merges its delivery into the oldest one of the barco.
    odoo.movimiento({ id: 102, picking: 700, lineas: [6] })

    const { canceladas } = await aplicarReasignacion(plan, 800)

    expect(canceladas).toEqual([])
    expect(odoo.estadoDe(700)).toBe('assigned')
    expect(odoo.movimientos.get(102)?.state).toBe('assigned')
  })

  it('cancels a delivery an earlier attempt left empty, which is a draft by then', async () => {
    odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2] })
    // An earlier attempt moved both lines and was cut before cancelling.
    odoo.movimientos.get(100)!.picking = 800
    odoo.lineas.get(1)!.picking = 800
    odoo.lineas.get(2)!.picking = 800

    const { plan, canceladas } = await mover(paquetes(1, 2), [700])

    expect(plan.lineas).toEqual([])
    expect(canceladas).toEqual([{ id: 700, ref: 'MB92/OUT/00700' }])
    expect(odoo.escriturasHechas().map((llamada) => llamada.metodo)).toEqual(['action_cancel'])
  })

  it('does nothing for packages an earlier attempt already moved to the destino', async () => {
    odoo.movimiento({ id: 100, picking: 800, lineas: [1] })

    const { plan, canceladas } = await mover(paquetes(1))

    expect(plan).toMatchObject({ lineas: [], movimientosEnteros: [], salidas: [], aCancelar: [] })
    expect(canceladas).toEqual([])
    expect(odoo.escriturasHechas()).toEqual([])
  })

  it('finds by its package a line Odoo made again under another id, on a backorder of the barco', async () => {
    // The line 1 went to a backorder when an entrega left it in depósito, as line 51.
    odoo.entrega({ id: 701, barco: ORIGEN })
    odoo.movimiento({ id: 150, picking: 701, lineas: [51], lotes: ['QA-DHL-001'] })

    const { plan } = await mover([{ moveLineId: 1, trackingNumber: 'QA-DHL-001' }])

    expect(plan.lineas).toEqual([51])
    expect(odoo.lineas.get(51)?.picking).toBe(800)
    expect(odoo.estadoDe(701)).toBe('cancel')
  })

  it('refuses a package that is no longer waiting for delivery of the barco, before writing anything', async () => {
    odoo.movimiento({ id: 100, picking: 700, lineas: [1] })
    odoo.entrega({ id: 702, barco: ORIGEN, cerrado: 'done' })
    odoo.movimiento({ id: 102, picking: 702, lineas: [2], lotes: ['QA-ENTREGADO'] })

    const error = await planear(paquetes(1, 2)).catch((fallo: unknown) => fallo)

    expect(error).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect((error as Error).message).toContain('QA-ENTREGADO')
    expect(odoo.escriturasHechas()).toEqual([])
  })

  it('refuses a package of another barco, or of another almacén', async () => {
    odoo.entrega({ id: 703, barco: 999 })
    odoo.movimiento({ id: 103, picking: 703, lineas: [3] })
    odoo.entrega({ id: 704, barco: ORIGEN, tipo: 50 })
    odoo.movimiento({ id: 104, picking: 704, lineas: [4] })

    await expect(planear(paquetes(3))).rejects.toThrow(RespuestaOdooInesperadaError)
    await expect(planear(paquetes(4))).rejects.toThrow(RespuestaOdooInesperadaError)
  })

  it('refuses a package whose line is gone and whose number is nowhere to be found', async () => {
    await expect(planear([{ moveLineId: 1, trackingNumber: 'QA-PERDIDO' }])).rejects.toThrow('QA-PERDIDO')
    await expect(planear([{ moveLineId: 1, trackingNumber: null }])).rejects.toThrow('sin número')
  })

  it('refuses a move with demand that is not reserved: moving it would leave a phantom line', async () => {
    odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2], demanda: 3 })

    await expect(planear(paquetes(1))).rejects.toThrow('a medio reservar')
    expect(odoo.escriturasHechas()).toEqual([])
  })

  it('stops before handing anything over if Odoo merged the split back into its move', async () => {
    odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2, 3] })
    // As if Odoo took the new move for a draft and `_autoconfirm_picking` merged it into the move it came from.
    odoo.ignorarEstadoAlCrear = true

    await expect(mover(paquetes(2))).rejects.toThrow('Odoo no separó los paquetes')
    expect(odoo.lineasDe(800).map((linea) => linea.id)).toEqual([90])
    expect(odoo.lineasDe(700).map((linea) => linea.id)).toEqual([1, 2, 3])
  })

  it('says what leaves each delivery, for the notes', async () => {
    odoo.entrega({ id: 701, barco: ORIGEN })
    odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2] })
    odoo.movimiento({ id: 101, picking: 701, lineas: [3], lotes: [null] })

    const plan = await planear(paquetes(1, 3))

    expect(plan.salidas).toEqual([
      { entrega: { id: 700, ref: 'MB92/OUT/00700' }, trackingNumbers: ['T1'] },
      { entrega: { id: 701, ref: 'MB92/OUT/00701' }, trackingNumbers: [null] },
    ])
  })
})

describe('entregaDestino', () => {
  const destino = (guardadaId: number | null = null) => entregaDestino({ outTypeId: TIPO_DE_ENTREGA, barcoOdooId: DESTINO, guardadaId })

  it('keeps the delivery an earlier attempt took while it is still of the barco and not done', async () => {
    odoo.entrega({ id: 810, barco: DESTINO })
    odoo.entrega({ id: 800, barco: DESTINO })
    odoo.movimiento({ id: 900, picking: 800, lineas: [90] })

    expect(await destino(810)).toEqual({ id: 810, ref: 'MB92/OUT/00810' })
    expect(odoo.llamadas).toHaveLength(1)
  })

  it('takes the oldest delivery of the barco waiting to be handed over, as the cron merges into it', async () => {
    odoo.entrega({ id: 820, barco: DESTINO })
    odoo.movimiento({ id: 920, picking: 820, lineas: [92] })
    odoo.entrega({ id: 810, barco: DESTINO })
    odoo.movimiento({ id: 910, picking: 810, lineas: [91] })
    odoo.entrega({ id: 805, barco: DESTINO, cerrado: 'done' })
    odoo.entrega({ id: 806, barco: 999 })
    odoo.movimiento({ id: 906, picking: 806, lineas: [96] })

    expect(await destino()).toEqual({ id: 810, ref: 'MB92/OUT/00810' })
  })

  it('does not keep a delivery that was handed over since', async () => {
    odoo.entrega({ id: 810, barco: DESTINO, cerrado: 'done' })
    odoo.entrega({ id: 820, barco: DESTINO })
    odoo.movimiento({ id: 920, picking: 820, lineas: [92] })

    expect(await destino(810)).toEqual({ id: 820, ref: 'MB92/OUT/00820' })
  })

  it('takes a draft the webapp made earlier for this, and not one somebody made by hand', async () => {
    odoo.entrega({ id: 830, barco: DESTINO })
    odoo.entrega({ id: 840, barco: DESTINO, origin: ORIGEN_CAMBIO_DE_BARCO })

    expect(await destino()).toEqual({ id: 840, ref: 'MB92/OUT/00840' })
  })

  it('makes a new delivery of the barco, in the delivery type, when it has none', async () => {
    const creada = await destino()

    expect(odoo.pickings.get(creada.id)).toMatchObject({ tipo: TIPO_DE_ENTREGA, barco: DESTINO, origin: ORIGEN_CAMBIO_DE_BARCO })
    expect(creada.ref).toBe(odoo.pickings.get(creada.id)?.name)
  })
})
