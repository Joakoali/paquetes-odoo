import { afterEach, describe, expect, it, vi } from 'vitest'
import { notFound, redirect } from 'next/navigation'
import { ForbiddenError, UnauthorizedError } from './auth/guards'
import { ConfiguracionError, ErrorParaOperario } from './errores'
import { ejecutarAccion } from './acciones'

afterEach(() => {
  vi.restoreAllMocks()
})

/** console.error is where unexpected errors are logged: this keeps the test output clean and lets a test look at it. */
const silenciarConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => {})

describe('ejecutarAccion', () => {
  it('wraps what the action returns', async () =>
    expect(await ejecutarAccion(async () => 42)).toEqual({ ok: true, valor: 42 }))

  it('wraps an action that returns nothing', async () =>
    expect(await ejecutarAccion(async () => {})).toEqual({ ok: true, valor: undefined }))

  it('maps an expired session to a friendly message', async () =>
    expect(await ejecutarAccion(async () => { throw new UnauthorizedError('x') }))
      .toEqual({ ok: false, error: 'Tu sesión venció. Volvé a entrar.' }))

  it('maps a forbidden access to a friendly message, without the technical one', async () =>
    expect(await ejecutarAccion(async () => { throw new ForbiddenError('Operario sin acceso al almacén 9') }))
      .toEqual({ ok: false, error: 'No tenés acceso a esto.' }))

  it('shows ErrorParaOperario messages as they are', async () => {
    expect(await ejecutarAccion(async () => { throw new ErrorParaOperario('Esta recepción ya se envió a Odoo.') }))
      .toEqual({ ok: false, error: 'Esta recepción ya se envió a Odoo.' })
  })

  it('shows the messages of the subclasses of ErrorParaOperario as they are', async () => {
    expect(await ejecutarAccion(async () => { throw new ConfiguracionError('Falta el courier DHL en Odoo.') }))
      .toEqual({ ok: false, error: 'Falta el courier DHL en Odoo.' })
  })

  it('hides unexpected errors behind a generic message and logs them', async () => {
    const consola = silenciarConsoleError()
    const fallo = new Error('connect ECONNREFUSED 10.0.0.7:5432')

    expect(await ejecutarAccion(async () => { throw fallo }))
      .toEqual({ ok: false, error: 'Algo falló. Probá de nuevo.' })
    expect(consola.mock.calls.flat()).toContain(fallo)
  })

  it('hides a thrown value that is not an Error behind the same generic message', async () => {
    const consola = silenciarConsoleError()

    expect(await ejecutarAccion(async () => { throw 'boom' }))
      .toEqual({ ok: false, error: 'Algo falló. Probá de nuevo.' })
    expect(consola.mock.calls.flat()).toContain('boom')
  })

  it('does not log the errors it turns into a message for the operario: they are expected', async () => {
    const consola = silenciarConsoleError()

    await ejecutarAccion(async () => { throw new UnauthorizedError('x') })
    await ejecutarAccion(async () => { throw new ForbiddenError('x') })
    await ejecutarAccion(async () => { throw new ErrorParaOperario('x') })

    expect(consola).not.toHaveBeenCalled()
  })

  it('lets redirect() through, so that it keeps working from inside an action', async () => {
    const consola = silenciarConsoleError()

    await expect(ejecutarAccion(async () => { redirect('/login') }))
      .rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT') })
    expect(consola).not.toHaveBeenCalled()
  })

  it('lets notFound() through, so that it keeps working from inside an action', async () => {
    const consola = silenciarConsoleError()

    await expect(ejecutarAccion(async () => { notFound() }))
      .rejects.toMatchObject({ digest: expect.stringContaining('404') })
    expect(consola).not.toHaveBeenCalled()
  })
})
