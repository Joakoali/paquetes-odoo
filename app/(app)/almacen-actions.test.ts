import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { cookieStore } = vi.hoisted(() => ({ cookieStore: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } }))
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/admin/operarioAlmacenes', () => ({ operarioHasAlmacen: vi.fn() }))

import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { elegirAlmacenAction } from './almacen-actions'

const OPERARIO = { id: 'op-1', nombre: 'Veronika' }
const UN_ANIO = 60 * 60 * 24 * 365

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(OPERARIO as never)
  vi.mocked(operarioHasAlmacen).mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('elegirAlmacenAction', () => {
  it('refuses an almacén the operario is not assigned to and leaves the cookie alone', async () => {
    vi.mocked(operarioHasAlmacen).mockResolvedValue(false)

    expect(await elegirAlmacenAction(2)).toEqual({ ok: false, error: 'No tenés acceso a esto.' })

    expect(operarioHasAlmacen).toHaveBeenCalledWith(OPERARIO.id, 2)
    expect(cookieStore.set).not.toHaveBeenCalled()
    expect(cookieStore.delete).not.toHaveBeenCalled()
  })

  it('stores the chosen almacén in the paqueteria_almacen cookie for a year', async () => {
    expect(await elegirAlmacenAction(2)).toEqual({ ok: true, valor: undefined })

    expect(operarioHasAlmacen).toHaveBeenCalledWith(OPERARIO.id, 2)
    expect(cookieStore.set).toHaveBeenCalledTimes(1)
    expect(cookieStore.set).toHaveBeenCalledWith('paqueteria_almacen', '2', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: UN_ANIO,
    })
  })

  it('checks the almacén for the operario of the session, not for whoever the client says', async () => {
    await elegirAlmacenAction(3)

    expect(requireOperarioFromCookies).toHaveBeenCalledTimes(1)
    expect(vi.mocked(operarioHasAlmacen).mock.calls).toEqual([[OPERARIO.id, 3]])
  })

  it.each([
    ['not an integer', 1.5],
    ['not a number', Number.NaN],
    ['a string', '1'],
    ['nothing', undefined],
    ['null', null],
  ])('refuses %s as an almacén id without asking the database or touching the cookie', async (_nombre, valor) => {
    expect(await elegirAlmacenAction(valor as never)).toEqual({ ok: false, error: 'No tenés acceso a esto.' })

    expect(operarioHasAlmacen).not.toHaveBeenCalled()
    expect(cookieStore.set).not.toHaveBeenCalled()
  })

  it('answers with the expired-session message and leaves the cookie alone when there is no session', async () => {
    vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('No session token'))

    expect(await elegirAlmacenAction(2)).toEqual({ ok: false, error: 'Tu sesión venció. Volvé a entrar.' })

    expect(operarioHasAlmacen).not.toHaveBeenCalled()
    expect(cookieStore.set).not.toHaveBeenCalled()
  })

  it('hides a failure of the database behind the generic message, with the cookie untouched', async () => {
    const consola = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(operarioHasAlmacen).mockRejectedValue(new Error('connection terminated'))

    expect(await elegirAlmacenAction(2)).toEqual({ ok: false, error: 'Algo falló. Probá de nuevo.' })

    expect(consola).toHaveBeenCalled()
    expect(cookieStore.set).not.toHaveBeenCalled()
  })
})
