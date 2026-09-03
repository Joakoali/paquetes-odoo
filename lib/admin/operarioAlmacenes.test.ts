import { describe, it, expect, vi, beforeEach } from 'vitest'

const links: Array<{ operarioId: string; almacenId: number }> = []
const almacenRows = [{ id: 1, prefijo: 'MB92', nombre: 'Barcelona', odooPickingTypeId: null }]

vi.mock('../../db/client', () => ({
  db: {
    query: {
      operarioAlmacenes: {
        findMany: async ({ where }: any) => {
          if (!where) return links
          // Handle Drizzle eq() expression: eq() returns an object with details about the comparison
          // For simplified mocking, extract the value being compared
          if (typeof where === 'object' && where.right !== undefined) {
            return links.filter((l) => l.operarioId === where.right)
          }
          return links
        },
      },
    },
    delete: () => ({
      where: async (whereExpr: any) => {
        if (whereExpr && whereExpr.right !== undefined) {
          const idx = links.findIndex((l) => l.operarioId === whereExpr.right)
          if (idx >= 0) links.splice(idx, 1)
        } else {
          links.length = 0
        }
      },
    }),
    insert: () => ({ values: (rows: any[]) => ({ then: (r: any) => Promise.resolve(links.push(...rows)).then(r) }) }),
    select: () => ({ from: () => ({ where: async () => almacenRows }) }),
  },
}))

import { getAlmacenesForOperario, setAlmacenesForOperario } from './operarioAlmacenes'

beforeEach(() => { links.length = 0 })

describe('operario almacenes', () => {
  it('replaces the set of assigned almacenes', async () => {
    await setAlmacenesForOperario('op-1', [1])
    expect(links).toEqual([{ operarioId: 'op-1', almacenId: 1 }])
    const result = await getAlmacenesForOperario('op-1')
    expect(result).toEqual(almacenRows)
  })
})
