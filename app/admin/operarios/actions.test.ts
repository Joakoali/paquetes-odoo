import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireAdminFromCookies: vi.fn() }))
// bcrypt at cost 12 is slow and is not what is under test.
vi.mock('@/lib/auth/password', () => ({ hashPassword: async (p: string) => `hashed:${p}` }))

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { auditLog, operarios, type Operario } from '@/db/schema'
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/guards'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { createOperarioAction, toggleOperarioActivoAction } from './actions'

const SIN_ACCESO = 'No tenés acceso a esto.'
const SESION_VENCIDA = 'Tu sesión venció. Volvé a entrar.'

let admin: Operario

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  admin = await seedOperario(db, { nombre: 'Joaquín', login: 'joaquin', rol: 'admin' })
  vi.mocked(requireAdminFromCookies).mockResolvedValue(admin)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const auditoria = () => db.select().from(auditLog)
const operarioDeLogin = (login: string) => db.query.operarios.findFirst({ where: eq(operarios.login, login) })

const ANA = { nombre: 'Ana', login: 'ana', password: 'secreto', rol: 'operario' }

/** Each way of not being let in, with what the admin screen says for it. */
const SIN_PASE: Array<[quien: string, error: Error, mensaje: string]> = [
  ['an operario who is not an admin', new ForbiddenError('Admin role required'), SIN_ACCESO],
  ['an expired session', new UnauthorizedError('Invalid or expired session'), SESION_VENCIDA],
]

describe('createOperarioAction', () => {
  it('creates the operario and audits it as the admin who did it, with who it is and never the password', async () => {
    expect(await createOperarioAction(ANA)).toEqual({ ok: true, valor: undefined })

    const ana = await operarioDeLogin('ana')
    expect(ana).toMatchObject({ nombre: 'Ana', rol: 'operario', activo: true, passwordHash: 'hashed:secreto' })
    const filas = await auditoria()
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      operarioId: admin.id,
      accion: 'admin_operario_creado',
      detalle: { operarioId: ana!.id, login: 'ana', rol: 'operario' },
    })
    expect(JSON.stringify(filas[0].detalle)).not.toMatch(/secreto|hashed/)
    expect(revalidatePath).toHaveBeenCalledWith('/admin/operarios')
  })

  it('creates an admin when the rol is admin, and an operario for anything else', async () => {
    await createOperarioAction({ ...ANA, login: 'a', rol: 'admin' })
    await createOperarioAction({ ...ANA, login: 'b', rol: 'superadmin' })
    await createOperarioAction({ ...ANA, login: 'c', rol: 'operario' })

    expect((await operarioDeLogin('a'))?.rol).toBe('admin')
    expect((await operarioDeLogin('b'))?.rol).toBe('operario')
    expect((await operarioDeLogin('c'))?.rol).toBe('operario')
  })

  it('takes the spaces off the name and the login, and not off the password', async () => {
    await createOperarioAction({ nombre: '  Ana  ', login: ' ana ', password: ' secreto ', rol: 'operario' })

    expect(await operarioDeLogin('ana')).toMatchObject({ nombre: 'Ana', login: 'ana', passwordHash: 'hashed: secreto ' })
  })

  it.each([
    ['name', { nombre: '  ' }, 'Falta el nombre.'],
    ['login', { login: '' }, 'Falta el usuario.'],
    ['password', { password: '' }, 'Falta la contraseña.'],
    ['login that is too long', { login: 'a'.repeat(65) }, 'El usuario puede tener hasta 64 caracteres.'],
  ])('refuses a missing or invalid %s and creates and audits nothing', async (_campo, cambio, mensaje) => {
    expect(await createOperarioAction({ ...ANA, ...cambio })).toEqual({ ok: false, error: mensaje })

    expect(await db.select().from(operarios)).toHaveLength(1)
    expect(await auditoria()).toEqual([])
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('refuses a login that is already taken, in words, and audits nothing', async () => {
    await createOperarioAction(ANA)
    vi.mocked(revalidatePath).mockClear()

    expect(await createOperarioAction({ ...ANA, nombre: 'Otra Ana' }))
      .toEqual({ ok: false, error: 'Ya hay un operario con el usuario "ana".' })

    expect(await auditoria()).toHaveLength(1)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it.each(SIN_PASE)('creates and audits nothing for %s', async (_quien, error, mensaje) => {
    vi.mocked(requireAdminFromCookies).mockRejectedValue(error)

    expect(await createOperarioAction(ANA)).toEqual({ ok: false, error: mensaje })

    expect(await operarioDeLogin('ana')).toBeUndefined()
    expect(await auditoria()).toEqual([])
  })
})

describe('toggleOperarioActivoAction', () => {
  it.each([false, true])('sets activo to %s and audits it as the admin who did it', async (activo) => {
    const ana = await seedOperario(db, { nombre: 'Ana', activo: !activo })

    expect(await toggleOperarioActivoAction(ana.id, activo)).toEqual({ ok: true, valor: undefined })

    expect((await db.query.operarios.findFirst({ where: eq(operarios.id, ana.id) }))?.activo).toBe(activo)
    const filas = await auditoria()
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      operarioId: admin.id,
      accion: 'admin_operario_activo',
      detalle: { operarioId: ana.id, activo },
    })
    expect(revalidatePath).toHaveBeenCalledWith('/admin/operarios')
  })

  it.each(SIN_PASE)('changes and audits nothing for %s', async (_quien, error, mensaje) => {
    const ana = await seedOperario(db, { nombre: 'Ana' })
    vi.mocked(requireAdminFromCookies).mockRejectedValue(error)

    expect(await toggleOperarioActivoAction(ana.id, false)).toEqual({ ok: false, error: mensaje })

    expect((await db.query.operarios.findFirst({ where: eq(operarios.id, ana.id) }))?.activo).toBe(true)
    expect(await auditoria()).toEqual([])
  })
})
