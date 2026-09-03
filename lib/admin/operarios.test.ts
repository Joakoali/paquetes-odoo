import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: any[] = []
vi.mock('../../db/client', () => ({
  db: {
    query: { operarios: { findMany: async () => rows } },
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { id: `op-${rows.length + 1}`, activo: true, ...v }
          rows.push(row)
          return [row]
        },
      }),
    }),
    update: () => ({
      set: (v: any) => ({
        where: async () => { Object.assign(rows[0], v) },
      }),
    }),
  },
}))
vi.mock('../auth/password', () => ({ hashPassword: async (p: string) => `hashed:${p}` }))

import { listOperarios, createOperario, setOperarioActivo } from './operarios'

beforeEach(() => { rows.length = 0 })

describe('admin operarios', () => {
  it('creates an operario with a hashed password', async () => {
    const op = await createOperario({ nombre: 'Ana', login: 'ana', password: 'secret', rol: 'operario' })
    expect(op.passwordHash).toBe('hashed:secret')
    expect(await listOperarios()).toHaveLength(1)
  })

  it('toggles activo', async () => {
    await createOperario({ nombre: 'Ana', login: 'ana', password: 'secret', rol: 'operario' })
    await setOperarioActivo('op-1', false)
    expect(rows[0].activo).toBe(false)
  })
})
