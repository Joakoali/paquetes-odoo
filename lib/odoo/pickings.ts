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
  const moveId = await callKw<number>('stock.move', 'create', [{
    picking_id: pickingId,
    product_id: courierProductId,
    product_uom_qty: trackingNumbers.length,
    name: 'Recepción webapp',
  }])

  await callKw<number[]>('stock.move.line', 'create', [
    trackingNumbers.map((lot_name) => ({
      move_id: moveId,
      picking_id: pickingId,
      product_id: courierProductId,
      lot_name,
      qty_done: 1,
    })),
  ])

  return moveId
}

export async function validatePicking(pickingId: number): Promise<void> {
  await callKw('stock.picking', 'action_confirm', [[pickingId]])
  await callKw('stock.picking', 'action_assign', [[pickingId]])
  await callKw('stock.picking', 'button_validate', [[pickingId]])
}
