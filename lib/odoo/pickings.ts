import { odooCall } from './client'
import { ConfiguracionError, RespuestaOdooInesperadaError } from '../errores'
import { parseFechaOdoo } from '../fechas'

/** A Many2one as `search_read` returns it: `[id, displayName]`, or `false` when it is empty. */
type Many2one = [number, string] | false

interface MoveLineLotRead {
  lot_id: [number, string] | false
  picking_id: [number, string] | false
}

/** Odoo `create` returns the new id(s); JSON-2 may hand back a scalar or a list. */
function firstId(res: number | number[]): number {
  return Array.isArray(res) ? res[0] : res
}

/** What stands for the picking of a move line that is in none (an inventory adjustment, say). */
const SIN_PICKING = 'Odoo (sin albarán)'

/**
 * Where Odoo already has each of these tracking numbers: tracking number to the name of the picking
 * ('MB92/IN/00010') whose move line (not cancelled) carries it. A tracking number Odoo does not have is
 * not in the map. One request, whatever the number of tracking numbers.
 *
 * When a tracking number is on lines of two pickings (the reception, and the delivery that took it
 * out) the first one stays. A line in no picking only names the place when there is no other line.
 */
export async function checkDuplicateTrackingNumbers(trackingNumbers: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  if (trackingNumbers.length === 0) return found
  const rows = await odooCall<MoveLineLotRead[]>('stock.move.line', 'search_read', {
    domain: [
      ['lot_id.name', 'in', trackingNumbers],
      ['state', '!=', 'cancel'],
    ],
    fields: ['lot_id', 'picking_id'],
  })
  for (const row of rows) {
    if (!row.lot_id) continue
    const trackingNumber = row.lot_id[1]
    if (found.has(trackingNumber) && found.get(trackingNumber) !== SIN_PICKING) continue
    found.set(trackingNumber, row.picking_id ? row.picking_id[1] : SIN_PICKING)
  }
  return found
}

/**
 * The name of the picking field that holds the barco. It is a custom field, so its name comes from
 * the environment and is never written in the code.
 */
function campoBarco(): string {
  const campo = process.env.ODOO_FIELD_BARCO
  if (!campo) throw new ConfiguracionError('ODOO_FIELD_BARCO no está configurado')
  return campo
}

export async function createIncomingPicking(almacenPickingTypeId: number, barcoOdooId: number): Promise<number> {
  const barcoField = campoBarco()

  const res = await odooCall<number | number[]>('stock.picking', 'create', {
    vals_list: [{
      picking_type_id: almacenPickingTypeId,
      [barcoField]: barcoOdooId,
    }],
  })
  return firstId(res)
}

export async function addCourierMoveWithLines(
  pickingId: number,
  courierProductId: number,
  trackingNumbers: string[],
  locationId: number,
  locationDestId: number,
): Promise<number> {
  // Odoo 19: `stock.move` has no `name` field (removed); use `description_picking`
  // for the human-readable trace. `location_id`/`location_dest_id` are NOT derived
  // from `picking_id` by a raw ORM `create()` (that only happens via UI onchange) —
  // pass the picking's own locations explicitly or Odoo raises a NotNullViolation.
  // `picked` lives on both stock.move and stock.move.line here — set it on both so
  // button_validate has nothing to ask.
  const res = await odooCall<number | number[]>('stock.move', 'create', {
    vals_list: [{
      picking_id: pickingId,
      product_id: courierProductId,
      product_uom_qty: trackingNumbers.length,
      description_picking: 'Recepción webapp',
      location_id: locationId,
      location_dest_id: locationDestId,
      picked: true,
    }],
  })
  const moveId = firstId(res)

  await odooCall<number[]>('stock.move.line', 'create', {
    vals_list: trackingNumbers.map((lot_name) => ({
      move_id: moveId,
      picking_id: pickingId,
      product_id: courierProductId,
      lot_name,
      quantity: 1,
      picked: true,
    })),
  })

  return moveId
}

export async function validatePicking(pickingId: number): Promise<void> {
  await odooCall('stock.picking', 'action_confirm', { ids: [pickingId] })
  await odooCall('stock.picking', 'action_assign', { ids: [pickingId] })
  await odooCall('stock.picking', 'button_validate', { ids: [pickingId] })
}

/**
 * What a delivery waiting to be handed over is: of the delivery type, with a barco, and neither draft,
 * done nor cancelled. The list of barcos and the list of packages both read with it, so "pending"
 * cannot mean one thing on one screen and another on the next.
 *
 * `picking_type_code` is left out on purpose: the operation type already says it is a delivery.
 * Asking for the reception type of the almacén together with `outgoing` can never match.
 */
function dominioEntregasPendientes(outTypeId: number, barcoField: string) {
  return [
    ['picking_type_id', '=', outTypeId],
    ['state', 'not in', ['draft', 'done', 'cancel']],
    [barcoField, '!=', false],
  ]
}

/** A picking as read for the list of barcos. Its barco is under the key that `ODOO_FIELD_BARCO` names, hence the index signature. */
interface PickingConBarcoRead {
  move_line_ids: number[]
  create_date: string
  [campo: string]: unknown
}

/** A barco that has deliveries waiting in Odoo. */
export interface BarcoConEntrega {
  barcoOdooId: number
  barcoNombre: string
  /** The move lines of its pending deliveries: one per package. */
  paquetes: number
  /** When the oldest of those deliveries was created. */
  desde: Date
}

/**
 * The barcos with a delivery waiting in the operation type `outTypeId` (the delivery type of an almacén),
 * one entry per barco, in no particular order. One request.
 */
export async function getBarcosConEntregaPendiente(outTypeId: number): Promise<BarcoConEntrega[]> {
  const barcoField = campoBarco()
  const pickings = await odooCall<PickingConBarcoRead[]>('stock.picking', 'search_read', {
    domain: dominioEntregasPendientes(outTypeId, barcoField),
    fields: [barcoField, 'move_line_ids', 'create_date'],
  })

  // By id and not by name: two barcos can be called the same.
  const barcos = new Map<number, BarcoConEntrega>()
  for (const picking of pickings) {
    const barco = picking[barcoField] as Many2one
    // The domain already rules out a picking without barco; the check is for the types.
    if (!barco) continue
    const [barcoOdooId, barcoNombre] = barco
    const desde = parseFechaOdoo(picking.create_date)

    const acumulado = barcos.get(barcoOdooId)
    if (!acumulado) {
      barcos.set(barcoOdooId, { barcoOdooId, barcoNombre, paquetes: picking.move_line_ids.length, desde })
      continue
    }
    acumulado.paquetes += picking.move_line_ids.length
    if (desde.getTime() < acumulado.desde.getTime()) acumulado.desde = desde
  }
  return [...barcos.values()]
}

/** One package (a move line) on a delivery waiting to be handed over. */
export interface LineaEntrega {
  moveLineId: number
  pickingId: number
  /** The name of the delivery the line is on, e.g. `MB92/OUT/00487`. */
  pickingRef: string
  /** Null for a line without lot: a product that is not tracked by serial number has no package number. */
  trackingNumber: string | null
  /** The product of the line, which is the courier. */
  courierNombre: string
}

interface LineaEntregaRead {
  id: number
  picking_id: Many2one
  lot_id: Many2one
  product_id: Many2one
}

/** What stands for the product of a line that came back without one, so that the line is still shown. */
const SIN_PRODUCTO = 'Sin producto'

/**
 * Every line of the deliveries waiting for the barco in the operation type `outTypeId`, those of all its
 * pending deliveries together. The lines without lot are returned too, with no tracking number: the crew
 * signs for what they see, so nothing is left out. Two requests, or one when the barco has no pending delivery.
 */
export async function getLineasEntregaPendiente(entrada: { outTypeId: number; barcoOdooId: number }): Promise<LineaEntrega[]> {
  const { outTypeId, barcoOdooId } = entrada
  const barcoField = campoBarco()
  const pickings = await odooCall<Array<{ id: number }>>('stock.picking', 'search_read', {
    domain: [...dominioEntregasPendientes(outTypeId, barcoField), [barcoField, '=', barcoOdooId]],
    fields: ['id'],
  })
  if (pickings.length === 0) return []

  const lineas = await odooCall<LineaEntregaRead[]>('stock.move.line', 'search_read', {
    domain: [['picking_id', 'in', pickings.map((picking) => picking.id)]],
    fields: ['picking_id', 'lot_id', 'product_id'],
  })
  // The domain already rules out a line in no picking; the check is for the types.
  return lineas.flatMap((linea) => (linea.picking_id
    ? [{
        moveLineId: linea.id,
        pickingId: linea.picking_id[0],
        pickingRef: linea.picking_id[1],
        trackingNumber: linea.lot_id ? linea.lot_id[1] : null,
        courierNombre: linea.product_id ? linea.product_id[1] : SIN_PRODUCTO,
      }]
    : []))
}

/**
 * Validates a delivery with only the lines chosen, and leaves the others in depósito: Odoo makes a native
 * backorder of what was not delivered. Says how many lines stay behind.
 *
 * The validation looks at which lines are picked, so, in this order: it reads the lines of the picking,
 * marks the chosen ones as picked and the rest (if there is a rest) as not picked, and validates. With a
 * rest the validation carries `skip_backorder`, so that Odoo makes the backorder instead of opening the
 * wizard that asks whether to; without one there is nothing to skip and it carries no context. If Odoo
 * answers with an action (a wizard it wants confirmed) and not with `true`, nobody is there to answer it:
 * it is an error.
 *
 * A chosen line that is not on the picking is not marked, nor counted. Nothing is marked or validated when
 * no chosen line is on the picking: the validation would run with every line unpicked, which nobody asked for.
 *
 * This is the only place that knows how Odoo splits a delivery. The worker only says what to deliver.
 */
export async function validarEntrega(entrada: {
  pickingId: number
  moveLineIdsElegidas: number[]
}): Promise<{ quedanEnDeposito: number }> {
  const { pickingId } = entrada

  const [picking] = await odooCall<Array<{ move_line_ids: number[] }>>('stock.picking', 'read', {
    ids: [pickingId],
    fields: ['move_line_ids'],
  })
  if (!picking) throw new Error(`picking ${pickingId} no existe en Odoo`)

  const pedidas = new Set(entrada.moveLineIdsElegidas)
  const lineasDelPicking = new Set(picking.move_line_ids)
  const elegidas = [...pedidas].filter((linea) => lineasDelPicking.has(linea))
  const sinEntregar = picking.move_line_ids.filter((linea) => !pedidas.has(linea))
  if (elegidas.length === 0) {
    throw new Error(`Ninguna de las líneas elegidas está en el picking ${pickingId}`)
  }

  await odooCall('stock.move.line', 'write', { ids: elegidas, vals: { picked: true } })
  if (sinEntregar.length > 0) {
    await odooCall('stock.move.line', 'write', { ids: sinEntregar, vals: { picked: false } })
  }

  const res = await odooCall<true | { res_model: string }>('stock.picking', 'button_validate', {
    ids: [pickingId],
    ...(sinEntregar.length > 0 ? { context: { skip_backorder: true } } : {}),
  })
  if (typeof res === 'object' && res !== null) {
    throw new RespuestaOdooInesperadaError(`Odoo pidió confirmar (${res.res_model})`)
  }

  return { quedanEnDeposito: sinEntregar.length }
}
