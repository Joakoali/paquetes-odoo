import { odooCall } from './client'
import { ConfiguracionError } from '../errores'

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

export async function createIncomingPicking(almacenPickingTypeId: number, barcoOdooId: number): Promise<number> {
  const barcoField = process.env.ODOO_FIELD_BARCO
  if (!barcoField) throw new ConfiguracionError('ODOO_FIELD_BARCO no está configurado')

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

export interface PendingDelivery {
  id: number
  name: string
  trackingNumbers: string[]
}

interface PickingRead {
  id: number
  name: string
}

export async function getPendingOutgoing(almacenPickingTypeId: number, barcoOdooId: number): Promise<PendingDelivery[]> {
  const barcoField = process.env.ODOO_FIELD_BARCO
  if (!barcoField) throw new ConfiguracionError('ODOO_FIELD_BARCO no está configurado')

  const pickings = await odooCall<PickingRead[]>('stock.picking', 'search_read', {
    domain: [
      ['picking_type_id', '=', almacenPickingTypeId],
      [barcoField, '=', barcoOdooId],
      ['state', 'not in', ['draft', 'done', 'cancel']],
      ['picking_type_code', '=', 'outgoing'],
    ],
    fields: ['name'],
  })

  if (pickings.length === 0) return []

  const lines = await odooCall<Array<{ picking_id: [number, string]; lot_id: [number, string] | false }>>(
    'stock.move.line',
    'search_read',
    {
      domain: [['picking_id', 'in', pickings.map((p) => p.id)]],
      fields: ['picking_id', 'lot_id'],
    },
  )

  return pickings.map((p) => ({
    id: p.id,
    name: p.name,
    trackingNumbers: lines
      .filter((l) => l.picking_id[0] === p.id && l.lot_id)
      .map((l) => (l.lot_id as [number, string])[1]),
  }))
}
