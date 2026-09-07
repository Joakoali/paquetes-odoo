import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../odoo/client', () => ({ odooCall: vi.fn() }))
const rows: Array<{ odooId: number; nombre: string }> = []
const upsert = { set: null as any }
vi.mock('../../db/client', () => ({
  db: {
    insert: () => ({
      values: (v: any[]) => ({
        onConflictDoUpdate: async (config: any) => {
          upsert.set = config.set
          // Postgres semantics: an existing row keeps whatever the set clause
          // writes. `excluded.nombre` is the incoming name; the column itself
          // would be a self-assignment no-op.
          const takesIncomingNombre = JSON.stringify(config.set?.nombre?.queryChunks ?? [])
            .includes('excluded.nombre')
          for (const row of v) {
            const existing = rows.find((r) => r.odooId === row.odooId)
            if (!existing) rows.push({ ...row })
            else if (takesIncomingNombre) existing.nombre = row.nombre
          }
        },
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

import { odooCall } from '../odoo/client'
import { refreshBarcosCache, searchBarcos } from './barcos'

beforeEach(() => { rows.length = 0; upsert.set = null })

describe('barcos cache', () => {
  it('refreshBarcosCache upserts from project.project', async () => {
    vi.mocked(odooCall).mockResolvedValue([{ id: 1, name: 'MOONSHADOW' }])
    await refreshBarcosCache()
    expect(odooCall).toHaveBeenCalledWith('project.project', 'search_read', { domain: [], fields: ['name'] })
    expect(rows).toEqual([{ odooId: 1, nombre: 'MOONSHADOW' }])
  })

  it('refreshBarcosCache updates the name of a renamed barco', async () => {
    vi.mocked(odooCall).mockResolvedValue([{ id: 1, name: 'MOONSHADOW' }])
    await refreshBarcosCache()

    vi.mocked(odooCall).mockResolvedValue([{ id: 1, name: 'MOONSHADOW II' }])
    await refreshBarcosCache()

    expect(rows).toEqual([{ odooId: 1, nombre: 'MOONSHADOW II' }])
  })

  it('searchBarcos filters by ilike on nombre', async () => {
    rows.push({ odooId: 1, nombre: 'MOONSHADOW' })
    rows.push({ odooId: 2, nombre: 'SUNSET' })
    const result = await searchBarcos('moon')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ odooId: 1, nombre: 'MOONSHADOW' })
  })
})
