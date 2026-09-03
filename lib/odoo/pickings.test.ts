import { describe, it, expect, vi } from 'vitest'

vi.mock('./client', () => ({ callKw: vi.fn() }))
import { callKw } from './client'
import { checkDuplicateTrackingNumbers } from './pickings'

describe('checkDuplicateTrackingNumbers', () => {
  it('returns the tracking numbers already present in Odoo, via one call', async () => {
    vi.mocked(callKw).mockResolvedValue([
      { lot_id: [10, 'ABC123'] },
      { lot_id: [11, 'XYZ789'] },
    ])

    const result = await checkDuplicateTrackingNumbers(['ABC123', 'DEF456', 'XYZ789'])

    expect(result).toEqual(['ABC123', 'XYZ789'])
    expect(callKw).toHaveBeenCalledTimes(1)
    expect(callKw).toHaveBeenCalledWith(
      'stock.move.line',
      'search_read',
      [[
        ['lot_id.name', 'in', ['ABC123', 'DEF456', 'XYZ789']],
        ['state', '!=', 'cancel'],
      ]],
      { fields: ['lot_id'] },
    )
  })
})
