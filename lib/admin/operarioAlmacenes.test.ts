import { describe, it, expect, vi, beforeEach } from 'vitest'

const links: Array<{ operarioId: string; almacenId: number }> = []
const almacenRows = [
  { id: 1, prefijo: 'MB92', nombre: 'Barcelona', odooPickingTypeId: null },
  { id: 2, prefijo: 'MAD1', nombre: 'Madrid', odooPickingTypeId: null },
]

vi.mock('../../db/client', () => {
  // Drizzle statements are lazy: they run when awaited, or when db.batch()
  // executes them in order. The neon-http driver has NO transaction() — it
  // throws — so the mock deliberately does not provide one.
  const statement = (run: () => void) => {
    let done = false
    const exec = () => { if (!done) { done = true; run() } }
    return {
      exec,
      then: (onFulfilled: any, onRejected: any) => {
        exec()
        return Promise.resolve().then(onFulfilled, onRejected)
      },
    }
  }

  return {
    db: {
      delete: () => ({
        // Remove ALL matching rows. In real Drizzle, delete().where() removes all matches.
        // Test controls which rows exist; here we clear all since test only uses one operario.
        where: () => statement(() => { links.length = 0 }),
      }),
      insert: () => ({ values: (rows: any[]) => statement(() => { links.push(...rows) }) }),
      batch: async (statements: any[]) => { for (const s of statements) s.exec() },
      query: {
        operarioAlmacenes: {
          // Test controls the links array; mock ignores where-expression entirely
          findMany: async () => links,
          findFirst: async ({ where }: any) => links.find((l) => where(l, {
            eq: (a: any, b: any) => a === b,
            and: (...c: boolean[]) => c.every(Boolean),
          })),
        },
      },
      select: () => ({
        from: () => ({
          where: async () => {
            // Filter almacenRows to only those with IDs in current links array
            const almacenIdsInUse = new Set(links.map((l) => l.almacenId))
            return almacenRows.filter((a) => almacenIdsInUse.has(a.id))
          },
        }),
      }),
    },
  }
})

import { getAlmacenesForOperario, setAlmacenesForOperario, operarioHasAlmacen } from './operarioAlmacenes'

beforeEach(() => { links.length = 0 })

describe('operario almacenes', () => {
  it('replaces the set of assigned almacenes', async () => {
    await setAlmacenesForOperario('op-1', [1])
    expect(links).toEqual([{ operarioId: 'op-1', almacenId: 1 }])
    const result = await getAlmacenesForOperario('op-1')
    expect(result).toEqual([almacenRows[0]])
  })

  it('replaces previous assignments when called again', async () => {
    // First assignment: [1, 2]
    await setAlmacenesForOperario('op-1', [1, 2])
    expect(links).toEqual([
      { operarioId: 'op-1', almacenId: 1 },
      { operarioId: 'op-1', almacenId: 2 },
    ])

    // Replace with: [2]
    await setAlmacenesForOperario('op-1', [2])
    expect(links).toEqual([{ operarioId: 'op-1', almacenId: 2 }])

    // Verify retrieval returns only almacen 2
    const result = await getAlmacenesForOperario('op-1')
    expect(result).toEqual([almacenRows[1]])
  })

  it('clears every assignment when given an empty list', async () => {
    await setAlmacenesForOperario('op-1', [1, 2])
    await setAlmacenesForOperario('op-1', [])
    expect(links).toEqual([])
  })

  it('operarioHasAlmacen is true only for an assigned almacen', async () => {
    await setAlmacenesForOperario('op-1', [1])
    expect(await operarioHasAlmacen('op-1', 1)).toBe(true)
    expect(await operarioHasAlmacen('op-1', 2)).toBe(false)
    expect(await operarioHasAlmacen('op-2', 1)).toBe(false)
  })
})
