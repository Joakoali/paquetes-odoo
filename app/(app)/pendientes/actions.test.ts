import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/admin/operarioAlmacenes', () => ({ operarioHasAlmacen: vi.fn() }))
// The domain has its own tests: the actions are only checked for who may call it, and with what.
vi.mock('@/lib/sync/pendientes', () => ({ reintentar: vi.fn(), marcarRevisado: vi.fn() }))

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { sesionesEscaneo, type Almacen, type Operario } from '@/db/schema'
import type { ResultadoAccion } from '@/lib/acciones'
import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { marcarRevisado, reintentar } from '@/lib/sync/pendientes'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { marcarRevisadoAction, reintentarAction } from './actions'

const NO_EXISTE = '00000000-0000-4000-8000-000000000000'
const SIN_ACCESO = 'No tenés acceso a esto.'
const SESION_VENCIDA = 'Tu sesión venció. Volvé a entrar.'
const GENERICO = 'Algo falló. Probá de nuevo.'

let operario: Operario
let admin: Operario
/** An almacén the operario has. */
let mb92: Almacen
/** An almacén the operario does not have. */
let mad1: Almacen

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  operario = await seedOperario(db, { nombre: 'Veronika' })
  admin = await seedOperario(db, { nombre: 'Joaquín', rol: 'admin' })
  mb92 = await seedAlmacen(db)
  mad1 = await seedAlmacen(db, { prefijo: 'MAD1', nombre: 'Madrid (MAD1)', odooWarehouseId: 2, odooInTypeId: 3, odooOutTypeId: 4 })
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(operario)
  vi.mocked(operarioHasAlmacen).mockImplementation(async (_operarioId, almacenId) => almacenId === mb92.id)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A sesión with a problem, written straight to the database: the actions read it to find out whose almacén it is. */
async function crearSesion(datos: Partial<typeof sesionesEscaneo.$inferInsert> = {}) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: operario.id,
    almacenId: mb92.id,
    barcoOdooId: 673,
    tipo: 'recepcion',
    estado: 'error',
    ...datos,
  }).returning()
  return sesion
}

const noSeLlamoAlDominio = () => {
  expect(reintentar).not.toHaveBeenCalled()
  expect(marcarRevisado).not.toHaveBeenCalled()
}

/** Each action with a word for what it does, and the function of the domain it ends in. */
const ACCIONES: Array<[
  nombre: string, verbo: string, llamar: (sesionId: string) => Promise<ResultadoAccion>, dominio: () => typeof reintentar,
]> = [
  ['reintentarAction', 'retry', reintentarAction, () => reintentar],
  ['marcarRevisadoAction', 'review', marcarRevisadoAction, () => marcarRevisado],
]

describe.each(ACCIONES)('%s', (_nombre, verbo, llamar, dominio) => {
  it('refuses a session from an almacén the operario does not have', async () => {
    const sesion = await crearSesion({ almacenId: mad1.id })

    expect(await llamar(sesion.id)).toEqual({ ok: false, error: SIN_ACCESO })

    expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mad1.id)
    noSeLlamoAlDominio()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it(`an admin can ${verbo} any session`, async () => {
    vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)
    const deMad1 = await crearSesion({ almacenId: mad1.id })
    const deMb92 = await crearSesion({ almacenId: mb92.id, barcoOdooId: 674 })

    expect(await llamar(deMad1.id)).toEqual({ ok: true, valor: undefined })
    expect(await llamar(deMb92.id)).toEqual({ ok: true, valor: undefined })

    // Nobody checks the almacenes of an admin: they have no list of their own to be limited to.
    expect(operarioHasAlmacen).not.toHaveBeenCalled()
    expect(dominio()).toHaveBeenCalledTimes(2)
    expect(dominio()).toHaveBeenNthCalledWith(1, { sesionId: deMad1.id, operarioId: admin.id })
    expect(dominio()).toHaveBeenNthCalledWith(2, { sesionId: deMb92.id, operarioId: admin.id })
  })

  it('lets an operario with the almacén of the session do it, as themselves', async () => {
    const sesion = await crearSesion()

    expect(await llamar(sesion.id)).toEqual({ ok: true, valor: undefined })

    expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mb92.id)
    expect(dominio()).toHaveBeenCalledTimes(1)
    expect(dominio()).toHaveBeenCalledWith({ sesionId: sesion.id, operarioId: operario.id })
  })

  it.each(['recepcion', 'entrega'] as const)('works on the %s of an almacén the operario has', async (tipo) => {
    const sesion = await crearSesion({ tipo })

    expect(await llamar(sesion.id)).toEqual({ ok: true, valor: undefined })

    expect(dominio()).toHaveBeenCalledWith({ sesionId: sesion.id, operarioId: operario.id })
  })

  it('looks at the sesión it is asked for, not at another one', async () => {
    // The sesión of an almacén the operario has is written first: it is what a lookup that ignored the id would find.
    const propia = await crearSesion({ almacenId: mb92.id })
    const ajena = await crearSesion({ almacenId: mad1.id, barcoOdooId: 674 })

    expect(await llamar(ajena.id)).toEqual({ ok: false, error: SIN_ACCESO })
    expect(await llamar(propia.id)).toEqual({ ok: true, valor: undefined })
  })

  it('checks the almacén of that sesión, not any the operario has', async () => {
    vi.mocked(operarioHasAlmacen).mockResolvedValue(true)
    const sesion = await crearSesion({ almacenId: mad1.id })

    expect(await llamar(sesion.id)).toEqual({ ok: true, valor: undefined })

    expect(operarioHasAlmacen).toHaveBeenCalledTimes(1)
    expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mad1.id)
  })

  it('revalidates the Pendientes screen after doing it', async () => {
    const sesion = await crearSesion()

    await llamar(sesion.id)

    expect(revalidatePath).toHaveBeenCalledTimes(1)
    expect(revalidatePath).toHaveBeenCalledWith('/pendientes')
  })

  it('revalidates for the admin too', async () => {
    vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)
    const sesion = await crearSesion({ almacenId: mad1.id })

    await llamar(sesion.id)

    expect(revalidatePath).toHaveBeenCalledWith('/pendientes')
  })

  it('answers with the expired-session message, and does nothing, when there is no session', async () => {
    const sesion = await crearSesion()
    vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

    expect(await llamar(sesion.id)).toEqual({ ok: false, error: SESION_VENCIDA })

    expect(operarioHasAlmacen).not.toHaveBeenCalled()
    noSeLlamoAlDominio()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('hides a failure of the domain behind the generic message, and does not revalidate', async () => {
    const consola = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sesion = await crearSesion()
    vi.mocked(dominio()).mockRejectedValue(new Error('QStash unreachable'))

    expect(await llamar(sesion.id)).toEqual({ ok: false, error: GENERICO })

    expect(consola).toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  describe('an id that names no sesión', () => {
    it('is refused for an operario: there is no almacén to check their access against', async () => {
      expect(await llamar(NO_EXISTE)).toEqual({ ok: false, error: SIN_ACCESO })

      expect(operarioHasAlmacen).not.toHaveBeenCalled()
      noSeLlamoAlDominio()
      expect(revalidatePath).not.toHaveBeenCalled()
    })

    it('is left to the domain for an admin, which has nothing to do for it', async () => {
      vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)

      expect(await llamar(NO_EXISTE)).toEqual({ ok: true, valor: undefined })

      expect(dominio()).toHaveBeenCalledWith({ sesionId: NO_EXISTE, operarioId: admin.id })
    })
  })

  // Postgres would refuse these as ids (a failure that is logged and read as "Algo falló"), and the array is
  // the sly one: a regular expression reads [id] as that id, so only a check of the type keeps it from the query.
  describe.each([
    ['an operario', () => operario],
    ['an admin', () => admin],
  ])('something that is not an id, from %s', (_quien, quien) => {
    it.each(['s1', '', 'not-a-uuid', undefined, null, 42, [NO_EXISTE]])(
      'refuses %j without asking the database',
      async (id) => {
        vi.mocked(requireOperarioFromCookies).mockResolvedValue(quien())
        const consultaDeSesion = vi.spyOn(db.query.sesionesEscaneo, 'findFirst')

        expect(await llamar(id as never)).toEqual({ ok: false, error: SIN_ACCESO })

        expect(consultaDeSesion).not.toHaveBeenCalled()
        expect(operarioHasAlmacen).not.toHaveBeenCalled()
        noSeLlamoAlDominio()
        expect(revalidatePath).not.toHaveBeenCalled()
      },
    )
  })
})

describe('the two actions', () => {
  it('call only their own function of the domain', async () => {
    const sesion = await crearSesion()

    await reintentarAction(sesion.id)
    expect(reintentar).toHaveBeenCalledTimes(1)
    expect(marcarRevisado).not.toHaveBeenCalled()

    vi.mocked(reintentar).mockClear()
    await marcarRevisadoAction(sesion.id)
    expect(marcarRevisado).toHaveBeenCalledTimes(1)
    expect(reintentar).not.toHaveBeenCalled()
  })
})
