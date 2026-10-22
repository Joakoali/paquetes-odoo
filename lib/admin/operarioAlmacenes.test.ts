import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { almacenes, operarioAlmacenes, type Almacen, type Operario } from '@/db/schema'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { getAlmacenesForOperario, operarioHasAlmacen, setAlmacenesForOperario } from './operarioAlmacenes'

let operario: Operario
let otro: Operario
// Created out of alphabetical order, so that sorting by name shows.
let madrid: Almacen
let barcelona: Almacen
let valencia: Almacen

beforeEach(async () => {
  await resetTestDb(db as unknown as TestDb)
  operario = await seedOperario(db)
  otro = await seedOperario(db)
  madrid = await seedAlmacen(db, { prefijo: 'MAD1', nombre: 'Madrid', odooWarehouseId: 1 })
  barcelona = await seedAlmacen(db, { prefijo: 'MB92', nombre: 'Barcelona', odooWarehouseId: 2 })
  valencia = await seedAlmacen(db, { prefijo: 'VLC1', nombre: 'Valencia', odooWarehouseId: 3 })
})

const enlaces = (quien: Operario) =>
  db.select({ almacenId: operarioAlmacenes.almacenId }).from(operarioAlmacenes)
    .where(eq(operarioAlmacenes.operarioId, quien.id))
    .then((filas) => filas.map((f) => f.almacenId).sort((a, b) => a - b))

const desactivar = (almacen: Almacen) =>
  db.update(almacenes).set({ activo: false }).where(eq(almacenes.id, almacen.id))

describe('operario almacenes', () => {
  it('replaces the set of assigned almacenes', async () => {
    await setAlmacenesForOperario(operario.id, [madrid.id])

    expect(await enlaces(operario)).toEqual([madrid.id])
    expect(await getAlmacenesForOperario(operario.id)).toEqual([madrid])
  })

  it('replaces previous assignments when called again', async () => {
    await setAlmacenesForOperario(operario.id, [madrid.id, barcelona.id])
    expect(await enlaces(operario)).toEqual([madrid.id, barcelona.id])

    await setAlmacenesForOperario(operario.id, [barcelona.id])

    expect(await enlaces(operario)).toEqual([barcelona.id])
    expect(await getAlmacenesForOperario(operario.id)).toEqual([barcelona])
  })

  it('clears every assignment when given an empty list', async () => {
    await setAlmacenesForOperario(operario.id, [madrid.id, barcelona.id])

    await setAlmacenesForOperario(operario.id, [])

    expect(await enlaces(operario)).toEqual([])
    expect(await getAlmacenesForOperario(operario.id)).toEqual([])
  })

  it('does not touch the assignments of other operarios', async () => {
    await setAlmacenesForOperario(otro.id, [valencia.id])

    await setAlmacenesForOperario(operario.id, [madrid.id])
    await setAlmacenesForOperario(operario.id, [])

    expect(await enlaces(otro)).toEqual([valencia.id])
  })

  it('operarioHasAlmacen is true only for an assigned almacén', async () => {
    await setAlmacenesForOperario(operario.id, [madrid.id])
    await setAlmacenesForOperario(otro.id, [barcelona.id])

    expect(await operarioHasAlmacen(operario.id, madrid.id)).toBe(true)
    expect(await operarioHasAlmacen(operario.id, barcelona.id)).toBe(false)
    expect(await operarioHasAlmacen(otro.id, madrid.id)).toBe(false)
  })

  describe('getAlmacenesForOperario', () => {
    it('gives back only the almacenes of that operario', async () => {
      await setAlmacenesForOperario(operario.id, [madrid.id])
      await setAlmacenesForOperario(otro.id, [barcelona.id, valencia.id])

      expect(await getAlmacenesForOperario(operario.id)).toEqual([madrid])
    })

    it('gives back only almacenes that are still active', async () => {
      await setAlmacenesForOperario(operario.id, [madrid.id, barcelona.id])
      await desactivar(barcelona)

      expect(await getAlmacenesForOperario(operario.id)).toEqual([madrid])
    })

    it('gives back nothing for an operario whose almacenes are all inactive, or who has none', async () => {
      await setAlmacenesForOperario(operario.id, [madrid.id])
      await desactivar(madrid)

      expect(await getAlmacenesForOperario(operario.id)).toEqual([])
      expect(await getAlmacenesForOperario(otro.id)).toEqual([])
    })

    it('lists them by name, whichever order they were created or assigned in', async () => {
      await setAlmacenesForOperario(operario.id, [valencia.id, madrid.id, barcelona.id])

      expect((await getAlmacenesForOperario(operario.id)).map((a) => a.nombre)).toEqual(['Barcelona', 'Madrid', 'Valencia'])
    })

    it('sorts the names without caring about capitals', async () => {
      const minuscula = await seedAlmacen(db, { prefijo: 'ALC1', nombre: 'alicante', odooWarehouseId: 4 })
      await setAlmacenesForOperario(operario.id, [madrid.id, minuscula.id, barcelona.id])

      // Under the C collation "alicante" would come after every name that starts with a capital.
      expect((await getAlmacenesForOperario(operario.id)).map((a) => a.id))
        .toEqual([minuscula.id, barcelona.id, madrid.id])
    })

    it('puts two almacenes with the same name in the order of their ids, whatever order the database finds them in', async () => {
      const gemelaDeMadrid = await seedAlmacen(db, { prefijo: 'MAD2', nombre: 'Madrid', odooWarehouseId: 4 })
      // Rewriting Madrid moves its row after its twin's, and it is assigned last: without a tie-break the
      // database has every reason to answer the twin first, which is the opposite of the order of the ids.
      await db.update(almacenes).set({ activo: true }).where(eq(almacenes.id, madrid.id))
      await setAlmacenesForOperario(operario.id, [gemelaDeMadrid.id, madrid.id])

      expect((await getAlmacenesForOperario(operario.id)).map((a) => a.id)).toEqual([madrid.id, gemelaDeMadrid.id])
    })
  })
})
