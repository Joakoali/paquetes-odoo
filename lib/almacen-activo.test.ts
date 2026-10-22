import { beforeEach, describe, expect, it, vi } from 'vitest'

// The cookie store of the request: `get` answers what the test sets with `conCookie`.
const { cookieStore } = vi.hoisted(() => ({ cookieStore: { get: vi.fn() } }))
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }))
vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { almacenes, operarioAlmacenes, type Almacen, type Operario } from '@/db/schema'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { ALMACEN_COOKIE, getAlmacenActivo, requireAlmacenActivo } from './almacen-activo'
import { ErrorParaOperario } from './errores'

let operario: Operario
// Madrid is created first, so that "the first by id" and "the first by name" are not the same almacén.
let madrid: Almacen
let barcelona: Almacen
let valencia: Almacen

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  operario = await seedOperario(db)
  madrid = await seedAlmacen(db, { prefijo: 'MAD1', nombre: 'Madrid', odooWarehouseId: 1 })
  barcelona = await seedAlmacen(db, { prefijo: 'MB92', nombre: 'Barcelona', odooWarehouseId: 2 })
  valencia = await seedAlmacen(db, { prefijo: 'VLC1', nombre: 'Valencia', odooWarehouseId: 3 })
  conCookie(undefined)
})

/** What the request carries in the almacén cookie; undefined: no cookie at all. */
function conCookie(valor: string | undefined) {
  cookieStore.get.mockImplementation((nombre: string) =>
    nombre === ALMACEN_COOKIE && valor !== undefined ? { name: nombre, value: valor } : undefined)
}

async function asignar(quien: Operario, ...asignados: Almacen[]) {
  await db.insert(operarioAlmacenes).values(asignados.map((a) => ({ operarioId: quien.id, almacenId: a.id })))
}

async function desactivar(almacen: Almacen) {
  await db.update(almacenes).set({ activo: false }).where(eq(almacenes.id, almacen.id))
}

describe('getAlmacenActivo', () => {
  it('names the cookie paqueteria_almacen', () => {
    expect(ALMACEN_COOKIE).toBe('paqueteria_almacen')
  })

  it('defaults to the first assigned active almacén, by name', async () => {
    await asignar(operario, madrid, barcelona)

    const { activo, disponibles } = await getAlmacenActivo(operario.id)

    expect(activo?.id).toBe(barcelona.id)
    expect(disponibles.map((a) => a.id)).toEqual([barcelona.id, madrid.id])
  })

  it('uses the cookie when it points to an assigned almacén', async () => {
    await asignar(operario, madrid, barcelona)
    conCookie(String(madrid.id))

    const { activo, disponibles } = await getAlmacenActivo(operario.id)

    expect(activo?.id).toBe(madrid.id)
    expect(disponibles.map((a) => a.id)).toEqual([barcelona.id, madrid.id])
  })

  it('ignores a cookie for an almacén the operario cannot use', async () => {
    await asignar(operario, madrid, barcelona)
    conCookie(String(valencia.id)) // it exists, but it is not his

    expect((await getAlmacenActivo(operario.id)).activo?.id).toBe(barcelona.id)
  })

  it('ignores a cookie for an almacén that does not exist', async () => {
    await asignar(operario, madrid, barcelona)
    conCookie('9999')

    expect((await getAlmacenActivo(operario.id)).activo?.id).toBe(barcelona.id)
  })

  it.each(['', 'abc', '1abc', '1.5', ' 1', '-1', '0', '1e0'])(
    'ignores a cookie that is not an almacén id (%j)',
    async (valor) => {
      await asignar(operario, madrid, barcelona)
      conCookie(valor) // madrid.id is 1: a lax parse of "1abc", " 1" or "1e0" would pick it

      expect((await getAlmacenActivo(operario.id)).activo?.id).toBe(barcelona.id)
    },
  )

  it('skips almacenes that are no longer active', async () => {
    await asignar(operario, madrid, barcelona)
    await desactivar(barcelona)

    const { activo, disponibles } = await getAlmacenActivo(operario.id)

    expect(activo?.id).toBe(madrid.id)
    expect(disponibles.map((a) => a.id)).toEqual([madrid.id])
  })

  it('ignores a cookie that points to an almacén that is no longer active', async () => {
    await asignar(operario, madrid, barcelona)
    await desactivar(madrid)
    conCookie(String(madrid.id))

    expect((await getAlmacenActivo(operario.id)).activo?.id).toBe(barcelona.id)
  })

  it('has no active almacén when none is assigned', async () => {
    expect(await getAlmacenActivo(operario.id)).toEqual({ activo: null, disponibles: [] })
  })

  it('has no active almacén when the only one assigned is no longer active', async () => {
    await asignar(operario, madrid)
    await desactivar(madrid)

    expect(await getAlmacenActivo(operario.id)).toEqual({ activo: null, disponibles: [] })
  })

  it('does not offer the almacenes of other operarios', async () => {
    const otro = await seedOperario(db)
    await asignar(operario, madrid)
    await asignar(otro, barcelona, valencia)
    conCookie(String(barcelona.id))

    const { activo, disponibles } = await getAlmacenActivo(operario.id)

    expect(activo?.id).toBe(madrid.id)
    expect(disponibles.map((a) => a.id)).toEqual([madrid.id])
  })
})

describe('requireAlmacenActivo', () => {
  it('gives back the active almacén', async () => {
    await asignar(operario, madrid, barcelona)
    conCookie(String(madrid.id))

    expect((await requireAlmacenActivo(operario.id)).id).toBe(madrid.id)
  })

  it('tells an operario without almacenes to ask the admin', async () => {
    const error = await requireAlmacenActivo(operario.id).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ErrorParaOperario)
    expect((error as Error).message).toBe('No tenés almacenes asignados. Avisá al admin.')
  })

  it('tells the same to an operario whose only almacén is no longer active', async () => {
    await asignar(operario, madrid)
    await desactivar(madrid)

    await expect(requireAlmacenActivo(operario.id)).rejects.toThrow('No tenés almacenes asignados. Avisá al admin.')
  })
})
