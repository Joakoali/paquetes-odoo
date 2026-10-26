import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
// bcrypt at cost 12 is slow and is not what is under test.
vi.mock('../auth/password', () => ({ hashPassword: async (p: string) => `hashed:${p}` }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { almacenes, operarios } from '@/db/schema'
import { ErrorParaOperario } from '@/lib/errores'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { setAlmacenesForOperario } from './operarioAlmacenes'
import { createOperario, listOperarios, listOperariosConAlmacenes, setOperarioActivo } from './operarios'

beforeEach(async () => {
  await resetTestDb(db as unknown as TestDb)
})

describe('admin operarios', () => {
  it('creates an operario with a hashed password', async () => {
    const op = await createOperario({ nombre: 'Ana', login: 'ana', password: 'secret', rol: 'operario' })

    expect(op.passwordHash).toBe('hashed:secret')
    expect(op).toMatchObject({ nombre: 'Ana', login: 'ana', rol: 'operario', activo: true })
    expect(await listOperarios()).toHaveLength(1)
  })

  it('does not create two operarios with the same login, and says so in words', async () => {
    await createOperario({ nombre: 'Ana', login: 'ana', password: 'secret', rol: 'operario' })

    const segundo = createOperario({ nombre: 'Otra Ana', login: 'ana', password: 'otra', rol: 'admin' })

    await expect(segundo).rejects.toBeInstanceOf(ErrorParaOperario)
    await expect(segundo).rejects.toThrow('Ya hay un operario con el usuario "ana".')
    expect(await listOperarios()).toHaveLength(1)
  })

  it('toggles activo', async () => {
    const ana = await createOperario({ nombre: 'Ana', login: 'ana', password: 'secret', rol: 'operario' })
    const luis = await createOperario({ nombre: 'Luis', login: 'luis', password: 'secret', rol: 'operario' })

    await setOperarioActivo(ana.id, false)

    const filas = await db.select().from(operarios)
    expect(filas.find((o) => o.id === ana.id)?.activo).toBe(false)
    expect(filas.find((o) => o.id === luis.id)?.activo).toBe(true)

    await setOperarioActivo(ana.id, true)

    expect((await db.select().from(operarios).where(eq(operarios.id, ana.id)))[0].activo).toBe(true)
  })
})

describe('listOperariosConAlmacenes', () => {
  // Created out of order, both of the names and of the prefixes, so that sorting shows.
  const nuevaAlmacen = (prefijo: string, odooWarehouseId: number, datos: Partial<typeof almacenes.$inferInsert> = {}) =>
    seedAlmacen(db, { prefijo, nombre: `Almacén ${prefijo}`, odooWarehouseId, ...datos })

  it('returns the active almacén prefixes per operario', async () => {
    const veronika = await seedOperario(db, { nombre: 'Veronika' })
    const ana = await seedOperario(db, { nombre: 'Ana' })
    const mpv = await nuevaAlmacen('MPV', 2)
    const mb92 = await nuevaAlmacen('MB92', 1)
    const tgn = await nuevaAlmacen('TGN', 3)
    await setAlmacenesForOperario(veronika.id, [mpv.id, mb92.id])
    await setAlmacenesForOperario(ana.id, [tgn.id])

    const lista = await listOperariosConAlmacenes()

    expect(lista.map((o) => [o.nombre, o.almacenes])).toEqual([
      ['Ana', ['TGN']],
      ['Veronika', ['MB92', 'MPV']],
    ])
  })

  it('leaves out the almacenes that are no longer active', async () => {
    const operario = await seedOperario(db)
    const mb92 = await nuevaAlmacen('MB92', 1)
    const mlc = await nuevaAlmacen('MLC', 2)
    await setAlmacenesForOperario(operario.id, [mb92.id, mlc.id])
    await db.update(almacenes).set({ activo: false }).where(eq(almacenes.id, mlc.id))

    expect((await listOperariosConAlmacenes())[0].almacenes).toEqual(['MB92'])
  })

  it('lists an operario with no almacén, or with only inactive ones, with an empty list', async () => {
    const sinNada = await seedOperario(db, { nombre: 'Sin nada' })
    const soloInactivos = await seedOperario(db, { nombre: 'Solo inactivos' })
    const mlc = await nuevaAlmacen('MLC', 1, { activo: false })
    await setAlmacenesForOperario(soloInactivos.id, [mlc.id])

    const lista = await listOperariosConAlmacenes()

    expect(lista.map((o) => [o.id, o.almacenes])).toEqual([[sinNada.id, []], [soloInactivos.id, []]])
  })

  it('gives every column of the operario, the inactive ones and the admins included', async () => {
    const admin = await seedOperario(db, { nombre: 'Joaquín', rol: 'admin' })
    const baja = await seedOperario(db, { nombre: 'Zacarías', activo: false })

    const lista = await listOperariosConAlmacenes()

    expect(lista).toEqual([{ ...admin, almacenes: [] }, { ...baja, almacenes: [] }])
  })

  it('sorts the operarios by name without caring about capitals, and by id when the name is the same', async () => {
    const zeta = await seedOperario(db, { nombre: 'Zeta' })
    const minuscula = await seedOperario(db, { nombre: 'ana' })
    const mayuscula = await seedOperario(db, { nombre: 'Berta' })

    expect((await listOperariosConAlmacenes()).map((o) => o.id)).toEqual([minuscula.id, mayuscula.id, zeta.id])

    const gemelo = await seedOperario(db, { nombre: 'Zeta' })
    const ids = [zeta.id, gemelo.id].sort()
    expect((await listOperariosConAlmacenes()).map((o) => o.id).slice(-2)).toEqual(ids)
  })
})
