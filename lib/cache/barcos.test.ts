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
        where: (whereCondition: any) => {
          // Test-only mock: filter by ilike condition from drizzle expression
          let filterPattern: string | null = null
          if (Array.isArray((whereCondition as any)?.queryChunks)) {
            // Extract the pattern string from queryChunks
            // For ilike expressions, the pattern is a direct string chunk (not wrapped in Param)
            const chunks = (whereCondition as any).queryChunks
            const stringChunk = chunks.find((chunk: any) => typeof chunk === 'string')
            if (stringChunk) filterPattern = stringChunk
          }
          if (!filterPattern) {
            // Return a thenable that resolves to all rows
            return Promise.resolve(rows)
          }
          // Apply case-insensitive filter using ilike pattern (%query%)
          const lowerPattern = filterPattern.toLowerCase()
          const filtered = rows.filter((r) => r.nombre.toLowerCase().includes(lowerPattern.replace(/%/g, '')))
          return Promise.resolve(filtered)
        },
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

  it('searchBarcos filters by ilike on nombre', async () => {
    rows.push({ odooId: 1, nombre: 'MOONSHADOW' })
    rows.push({ odooId: 2, nombre: 'SUNSET' })
    const result = await searchBarcos('moon')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ odooId: 1, nombre: 'MOONSHADOW' })
  })
})
