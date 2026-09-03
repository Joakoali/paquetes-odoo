import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbState = { auth: [] as any[], operarios: [] as any[] }

vi.mock('../../db/client', () => ({
  db: {
    insert: () => ({
      values: (v: any) => {
        const row = { id: 'session-1', ...v }
        dbState.auth.push(row)
        return { returning: async () => [row] }
      },
    }),
    query: {
      sesionesAuth: {
        findFirst: async ({ where }: any) =>
          dbState.auth.find((r) => where(r, { eq: (a: any, b: any) => a === b })) ?? undefined,
      },
    },
    delete: () => ({ where: async () => { dbState.auth = [] } }),
  },
}))

import { createSession, getSessionOperario, destroySession } from './session'

beforeEach(() => {
  dbState.auth = []
  dbState.operarios = [{ id: 'op-1', nombre: 'Juan', login: 'juan', rol: 'operario', activo: true }]
})

describe('session', () => {
  it('creates a session and can be destroyed', async () => {
    const token = await createSession('op-1')
    expect(typeof token).toBe('string')
    await destroySession(token)
    expect(dbState.auth.length).toBe(0)
  })
})
