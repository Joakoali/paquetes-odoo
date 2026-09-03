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
