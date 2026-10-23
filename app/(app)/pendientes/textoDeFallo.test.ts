import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResultadoAccion } from '@/lib/acciones'
import { SIN_RESPUESTA, textoDeFallo } from './textoDeFallo'

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
