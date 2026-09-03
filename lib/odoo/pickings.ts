import { callKw } from './client'

interface MoveLineLotRead {
  lot_id: [number, string] | false
}

export async function checkDuplicateTrackingNumbers(trackingNumbers: string[]): Promise<string[]> {
  if (trackingNumbers.length === 0) return []
  const rows = await callKw<MoveLineLotRead[]>(
    'stock.move.line',
    'search_read',
    [[
      ['lot_id.name', 'in', trackingNumbers],
      ['state', '!=', 'cancel'],
    ]],
    { fields: ['lot_id'] },
  )
  const found = new Set(rows.filter((r) => r.lot_id).map((r) => (r.lot_id as [number, string])[1]))
  return trackingNumbers.filter((t) => found.has(t))
}

export async function createIncomingPicking(almacenPickingTypeId: number, barcoOdooId: number): Promise<number> {
  const barcoField = process.env.ODOO_FIELD_BARCO
  if (!barcoField) throw new Error('ODOO_FIELD_BARCO is not set')

  return callKw<number>('stock.picking', 'create', [{
    picking_type_id: almacenPickingTypeId,
    [barcoField]: barcoOdooId,
  }])
}

export async function addCourierMoveWithLines(
  pickingId: number,
  courierProductId: number,
  trackingNumbers: string[],
): Promise<number> {
  // TODO(task-22): confirmar contra la base de pruebas de Odoo 19. `qty_done`
  // desapareció en Odoo 17 (ahora `quantity` en stock.move.line) y el flag
  // `picked` puede tener que ir en la línea en vez de en el movimiento.
  const moveId = await callKw<number>('stock.move', 'create', [{
    picking_id: pickingId,
    product_id: courierProductId,
    product_uom_qty: trackingNumbers.length,
    name: 'Recepción webapp',
    picked: true,
  }])

  await callKw<number[]>('stock.move.line', 'create', [
    trackingNumbers.map((lot_name) => ({
      move_id: moveId,
      picking_id: pickingId,
      product_id: courierProductId,
      lot_name,
      quantity: 1,
    })),
  ])

  return moveId
}

export async function validatePicking(pickingId: number): Promise<void> {
  await callKw('stock.picking', 'action_confirm', [[pickingId]])
  await callKw('stock.picking', 'action_assign', [[pickingId]])
  await callKw('stock.picking', 'button_validate', [[pickingId]])
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
  if (!barcoField) throw new Error('ODOO_FIELD_BARCO is not set')

  const pickings = await callKw<PickingRead[]>('stock.picking', 'search_read', [[
    ['picking_type_id', '=', almacenPickingTypeId],
    [barcoField, '=', barcoOdooId],
    ['state', 'not in', ['draft', 'done', 'cancel']],
    ['picking_type_code', '=', 'outgoing'],
  ]], { fields: ['name'] })

  if (pickings.length === 0) return []

  const lines = await callKw<Array<{ picking_id: [number, string]; lot_id: [number, string] | false }>>(
    'stock.move.line',
    'search_read',
    [[['picking_id', 'in', pickings.map((p) => p.id)]]],
    { fields: ['picking_id', 'lot_id'] },
  )

  return pickings.map((p) => ({
    id: p.id,
    name: p.name,
    trackingNumbers: lines
      .filter((l) => l.picking_id[0] === p.id && l.lot_id)
      .map((l) => (l.lot_id as [number, string])[1]),
  }))
}
