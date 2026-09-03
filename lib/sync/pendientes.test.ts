// lib/sync/pendientes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../queue/publish', () => ({ publishSync: vi.fn() }))
const rows = [{ id: 's1', estado: 'error', ultimoError: 'timeout', intentos: 2 }]
vi.mock('../../db/client', () => ({
  db: {
    query: { sesionesEscaneo: { findMany: async () => rows } },
  },
}))

import { publishSync } from '../queue/publish'
import { listSessionsInError, retrySession } from './pendientes'

describe('pendientes', () => {
  it('lists sessions in error state', async () => {
    const result = await listSessionsInError()
    expect(result).toEqual(rows)
  })

  it('retrySession republishes to the sync queue', async () => {
    await retrySession('s1')
    expect(publishSync).toHaveBeenCalledWith({ sesionId: 's1' })
  })
})
