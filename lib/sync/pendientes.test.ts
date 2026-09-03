// lib/sync/pendientes.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('../queue/publish', () => ({ publishSync: vi.fn() }))
const rows = [{ id: 's1', estado: 'error', ultimoError: 'timeout', intentos: 2 }]
const duplicadoRows = [{ id: 's2', estado: 'sincronizada', ultimoError: null, intentos: 0 }]

// The duplicates query is a 3-table join; the mock records the chain and hands
// back the joined rows in Drizzle's `{ sesion: ... }` selection shape.
vi.mock('../../db/client', () => ({
  db: {
    query: { sesionesEscaneo: { findMany: async () => rows } },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              groupBy: async () => duplicadoRows.map((sesion) => ({ sesion })),
            }),
          }),
        }),
      }),
    }),
  },
}))

import { publishSync } from '../queue/publish'
import { listSessionsInError, listSessionsWithDuplicates, retrySession } from './pendientes'

describe('pendientes', () => {
  it('lists sessions in error state', async () => {
    const result = await listSessionsInError()
    expect(result).toEqual(rows)
  })

  it('lists synced sessions that still have duplicado items', async () => {
    const result = await listSessionsWithDuplicates()
    expect(result).toEqual(duplicadoRows)
  })

  it('retrySession republishes to the sync queue', async () => {
    await retrySession('s1')
    expect(publishSync).toHaveBeenCalledWith({ sesionId: 's1' })
  })
})
