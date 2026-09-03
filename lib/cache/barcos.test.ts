import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../odoo/client', () => ({ callKw: vi.fn() }))
const rows: Array<{ odooId: number; nombre: string }> = []
vi.mock('../../db/client', () => ({
  db: {
    insert: () => ({
      values: (v: any[]) => ({
        onConflictDoUpdate: async () => { rows.push(...v) },
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  },
}))

import { callKw } from '../odoo/client'
import { refreshBarcosCache, searchBarcos } from './barcos'

beforeEach(() => { rows.length = 0 })

describe('barcos cache', () => {
  it('refreshBarcosCache upserts from project.project', async () => {
    vi.mocked(callKw).mockResolvedValue([{ id: 1, name: 'MOONSHADOW' }])
    await refreshBarcosCache()
    expect(callKw).toHaveBeenCalledWith('project.project', 'search_read', [[]], { fields: ['name'] })
    expect(rows).toEqual([{ odooId: 1, nombre: 'MOONSHADOW' }])
  })

  it('searchBarcos reads from the local cache', async () => {
    rows.push({ odooId: 1, nombre: 'MOONSHADOW' })
    const result = await searchBarcos('moon')
    expect(result).toEqual(rows)
  })
})
