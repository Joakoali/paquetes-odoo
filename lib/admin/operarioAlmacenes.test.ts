import { describe, it, expect, vi, beforeEach } from 'vitest'

const links: Array<{ operarioId: string; almacenId: number }> = []
const almacenRows = [
  { id: 1, prefijo: 'MB92', nombre: 'Barcelona', odooPickingTypeId: null },
  { id: 2, prefijo: 'MAD1', nombre: 'Madrid', odooPickingTypeId: null },
]

vi.mock('../../db/client', () => ({
  db: {
    query: {
      operarioAlmacenes: {
        // Test controls the links array; mock ignores where-expression entirely
        findMany: async () => links,
      },
    },
    delete: () => ({
      where: async () => {
        // Remove ALL matching rows. In real Drizzle, delete().where() removes all matches.
        // Test controls which rows exist; here we clear all since test only uses one operario.
        links.length = 0
      },
    }),
    insert: () => ({ values: (rows: any[]) => ({ then: (r: any) => Promise.resolve(links.push(...rows)).then(r) }) }),
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
}))

import { getAlmacenesForOperario, setAlmacenesForOperario } from './operarioAlmacenes'

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
})
