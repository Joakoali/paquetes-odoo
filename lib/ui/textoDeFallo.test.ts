import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResultadoAccion } from '@/lib/acciones'
import { llamarAccion, SIN_RESPUESTA, sinRespuesta, textoDeFallo } from './textoDeFallo'

afterEach(() => {
  vi.restoreAllMocks()
})

type Accion = (sesionId: string) => Promise<ResultadoAccion>

/** An action that answers `resultado`. */
const queResponde = (resultado: ResultadoAccion) => vi.fn<Accion>().mockResolvedValue(resultado)

describe('textoDeFallo', () => {
  it('has nothing to show when the action worked', async () => {
    expect(await textoDeFallo(queResponde({ ok: true, valor: undefined }), 'sesion-1')).toBeNull()
  })

  it('has nothing to show either when the action worked and answered a value', async () => {
    expect(await textoDeFallo(queResponde({ ok: true, valor: 3 as never }), 'sesion-1')).toBeNull()
  })

  it('runs the action on the sesión it is given, once', async () => {
    const accion = queResponde({ ok: true, valor: undefined })

    await textoDeFallo(accion, 'sesion-1')

    expect(accion).toHaveBeenCalledTimes(1)
    expect(accion).toHaveBeenCalledWith('sesion-1')
  })

  it('shows the text the action answers when it could not do it, as it is', async () => {
    const texto = await textoDeFallo(queResponde({ ok: false, error: 'No tenés acceso a esto.' }), 'sesion-1')

    expect(texto).toBe('No tenés acceso a esto.')
  })

  it('shows a message, and does not throw, when the call itself fails: a tablet loses its connection', async () => {
    const consola = vi.spyOn(console, 'error').mockImplementation(() => {})
    const accion = vi.fn<Accion>().mockRejectedValue(new TypeError('Failed to fetch'))

    expect(await textoDeFallo(accion, 'sesion-1')).toBe(SIN_RESPUESTA)

    expect(accion).toHaveBeenCalledWith('sesion-1')
    // Not hidden from whoever has the console open: it is a failure to look at, only not a crash for the operario.
    expect(consola).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an Error', new Error('boom')],
    ['a string', 'boom'],
    ['nothing', undefined],
  ])('shows the same message when the call fails with %s', async (_caso, motivo) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const accion = vi.fn<Accion>().mockRejectedValue(motivo)

    expect(await textoDeFallo(accion, 'sesion-1')).toBe(SIN_RESPUESTA)
  })

  it('tells what to do about a call that got no answer', () => {
    expect(SIN_RESPUESTA).toBe('No hubo respuesta del servidor. Revisá la conexión y probá de nuevo.')
  })

  it('does not log anything when the action answers, even if the answer is a failure', async () => {
    const consola = vi.spyOn(console, 'error').mockImplementation(() => {})

    await textoDeFallo(queResponde({ ok: false, error: 'Algo falló. Probá de nuevo.' }), 'sesion-1')
    await textoDeFallo(queResponde({ ok: true, valor: undefined }), 'sesion-1')

    expect(consola).not.toHaveBeenCalled()
  })
})

describe('llamarAccion', () => {
  it('gives back what the action answered, a value included, as it is', async () => {
    const llamada = vi.fn().mockResolvedValue({ ok: true, valor: 'enviada' })

    expect(await llamarAccion(llamada)).toEqual({ ok: true, valor: 'enviada' })
    expect(llamada).toHaveBeenCalledTimes(1)
  })

  it('gives back the text of a failure the action expected, as it is', async () => {
    const resultado = await llamarAccion(async () => ({ ok: false as const, error: 'Esta recepción ya se envió a Odoo.' }))

    expect(resultado).toEqual({ ok: false, error: 'Esta recepción ya se envió a Odoo.' })
  })

  it('turns a call that fails into the "no hubo respuesta" failure instead of throwing, and logs it', async () => {
    const consola = vi.spyOn(console, 'error').mockImplementation(() => {})

    const resultado = await llamarAccion(async () => {
      throw new TypeError('Failed to fetch')
    })

    expect(resultado).toEqual({ ok: false, error: SIN_RESPUESTA, sinRespuesta: true })
    expect(consola).toHaveBeenCalledTimes(1)
  })

  it('does not log anything when the action answers', async () => {
    const consola = vi.spyOn(console, 'error').mockImplementation(() => {})

    await llamarAccion(async () => ({ ok: false as const, error: 'Algo falló. Probá de nuevo.' }))
    await llamarAccion(async () => ({ ok: true as const, valor: 1 }))

    expect(consola).not.toHaveBeenCalled()
  })
})

describe('sinRespuesta', () => {
  it('is true for a call that got no answer, which is all llamarAccion knows of it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(sinRespuesta(await llamarAccion(() => Promise.reject(new TypeError('Failed to fetch'))))).toBe(true)
  })

  it('is false for an action that answered, whether it worked or not', () => {
    expect(sinRespuesta({ ok: true, valor: undefined })).toBe(false)
    expect(sinRespuesta({ ok: false, error: 'No tenés acceso a esto.' })).toBe(false)
  })

  it('does not go by the text: an action that answers the same words did answer', () => {
    expect(sinRespuesta({ ok: false, error: SIN_RESPUESTA })).toBe(false)
  })
})
