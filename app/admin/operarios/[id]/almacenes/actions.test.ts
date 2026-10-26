import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireAdminFromCookies: vi.fn() }))

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { almacenes, auditLog, operarioAlmacenes, type Almacen, type Operario } from '@/db/schema'
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/guards'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { updateAlmacenesAction } from './actions'

const SIN_ACCESO = 'No tenés acceso a esto.'
const SESION_VENCIDA = 'Tu sesión venció. Volvé a entrar.'
const NO_VALIDOS = 'Los almacenes elegidos no son válidos.'
const NO_DISPONIBLES = 'Algunos de los almacenes elegidos no están disponibles. Recargá la pantalla y volvé a elegir.'

let admin: Operario
let operario: Operario
let mb92: Almacen
let mpv: Almacen

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  admin = await seedOperario(db, { nombre: 'Joaquín', rol: 'admin' })
  operario = await seedOperario(db, { nombre: 'Veronika' })
  mb92 = await seedAlmacen(db)
  mpv = await seedAlmacen(db, { prefijo: 'MPV', nombre: 'Port Vell (MPV)', odooWarehouseId: 2 })
  vi.mocked(requireAdminFromCookies).mockResolvedValue(admin)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const enlaces = () =>
  db.select({ almacenId: operarioAlmacenes.almacenId }).from(operarioAlmacenes)
    .where(eq(operarioAlmacenes.operarioId, operario.id))
    .then((filas) => filas.map((f) => f.almacenId).sort((a, b) => a - b))

const auditoria = () => db.select().from(auditLog)

describe('updateAlmacenesAction', () => {
  it('saves the almacenes and audits it as the admin who did it, with the operario and the almacenes', async () => {
    expect(await updateAlmacenesAction(operario.id, [mpv.id, mb92.id])).toEqual({ ok: true, valor: undefined })

    expect(await enlaces()).toEqual([mb92.id, mpv.id])
    const filas = await auditoria()
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      operarioId: admin.id,
      accion: 'admin_almacenes',
      detalle: { operarioId: operario.id, almacenIds: [mb92.id, mpv.id] },
    })
  })

  it('refreshes this screen and the list of operarios, which shows the almacenes of each', async () => {
    await updateAlmacenesAction(operario.id, [mb92.id])

    expect(revalidatePath).toHaveBeenCalledWith(`/admin/operarios/${operario.id}/almacenes`)
    expect(revalidatePath).toHaveBeenCalledWith('/admin/operarios')
  })

  it('saves and audits an empty choice: it takes the almacenes away', async () => {
    await updateAlmacenesAction(operario.id, [mb92.id])

    expect(await updateAlmacenesAction(operario.id, [])).toEqual({ ok: true, valor: undefined })

    expect(await enlaces()).toEqual([])
    expect((await auditoria())[1]).toMatchObject({ accion: 'admin_almacenes', detalle: { almacenIds: [] } })
  })

  it('counts an almacén chosen twice once', async () => {
    await updateAlmacenesAction(operario.id, [mb92.id, mb92.id])

    expect(await enlaces()).toEqual([mb92.id])
    expect((await auditoria())[0].detalle).toMatchObject({ almacenIds: [mb92.id] })
  })

  describe('an almacén that went inactive', () => {
    const desactivar = (almacen: Almacen) => db.update(almacenes).set({ activo: false }).where(eq(almacenes.id, almacen.id))

    it('is taken away when the admin unticks it, and the removal is audited', async () => {
      await updateAlmacenesAction(operario.id, [mb92.id, mpv.id])
      await desactivar(mpv)

      expect(await updateAlmacenesAction(operario.id, [mb92.id])).toEqual({ ok: true, valor: undefined })

      expect(await enlaces()).toEqual([mb92.id])
      expect((await auditoria())[1].detalle).toMatchObject({ almacenIds: [mb92.id] })
    })

    it('stays when the admin leaves it ticked', async () => {
      await updateAlmacenesAction(operario.id, [mb92.id, mpv.id])
      await desactivar(mpv)

      expect(await updateAlmacenesAction(operario.id, [mb92.id, mpv.id])).toEqual({ ok: true, valor: undefined })

      expect(await enlaces()).toEqual([mb92.id, mpv.id])
    })

    it('is refused with a plain message when the operario has no link to it, and nothing is changed, audited or refreshed', async () => {
      await updateAlmacenesAction(operario.id, [mb92.id])
      await desactivar(mpv)
      vi.mocked(revalidatePath).mockClear()

      expect(await updateAlmacenesAction(operario.id, [mb92.id, mpv.id])).toEqual({ ok: false, error: NO_DISPONIBLES })

      expect(await enlaces()).toEqual([mb92.id])
      expect(await auditoria()).toHaveLength(1)
      expect(revalidatePath).not.toHaveBeenCalled()
    })
  })

  it.each([
    ['a number that is not whole', [1.5]],
    ['a negative number', [-1]],
    ['NaN', [Number.NaN]],
    ['something that is not a number', ['1']],
    ['something that is not a list', 7],
  ])('refuses %s and changes and audits nothing', async (_que, ids) => {
    await updateAlmacenesAction(operario.id, [mb92.id])
    vi.mocked(revalidatePath).mockClear()

    expect(await updateAlmacenesAction(operario.id, ids as number[])).toEqual({ ok: false, error: NO_VALIDOS })

    expect(await enlaces()).toEqual([mb92.id])
    expect(await auditoria()).toHaveLength(1)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it.each([
    ['an operario who is not an admin', new ForbiddenError('Admin role required'), SIN_ACCESO],
    ['an expired session', new UnauthorizedError('Invalid or expired session'), SESION_VENCIDA],
  ])('changes and audits nothing for %s', async (_quien, error, mensaje) => {
    vi.mocked(requireAdminFromCookies).mockRejectedValue(error)

    expect(await updateAlmacenesAction(operario.id, [mb92.id])).toEqual({ ok: false, error: mensaje })

    expect(await enlaces()).toEqual([])
    expect(await auditoria()).toEqual([])
  })
})
