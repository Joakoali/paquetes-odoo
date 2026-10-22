import { unstable_rethrow } from 'next/navigation'
import { ForbiddenError, UnauthorizedError } from './auth/guards'
import { ErrorParaOperario } from './errores'

/**
 * What a server action answers. The failures that can be expected (an expired session, a
 * recepción that was already sent) are returned, not thrown: a thrown error reaches the client
 * as an opaque one, and an operario has to read why.
 */
export type ResultadoAccion<T = void> = { ok: true; valor: T } | { ok: false; error: string }

const MENSAJE_SESION_VENCIDA = 'Tu sesión venció. Volvé a entrar.'
const MENSAJE_SIN_ACCESO = 'No tenés acceso a esto.'
const MENSAJE_GENERICO = 'Algo falló. Probá de nuevo.'

/** What the operario reads for a failure. Only the unexpected ones are logged. */
function mensajeParaOperario(err: unknown): string {
  if (err instanceof UnauthorizedError) return MENSAJE_SESION_VENCIDA
  if (err instanceof ForbiddenError) return MENSAJE_SIN_ACCESO
  if (err instanceof ErrorParaOperario) return err.message

  console.error('Server action failed', err)
  return MENSAJE_GENERICO
}

/**
 * Runs the body of a server action and turns what it throws into a `ResultadoAccion`, so the
 * action never throws what an operario has to see. What Next throws on purpose (`redirect`,
 * `notFound`) is let through first, or those would stop working inside an action.
 */
export async function ejecutarAccion<T>(fn: () => Promise<T>): Promise<ResultadoAccion<T>> {
  try {
    return { ok: true, valor: await fn() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, error: mensajeParaOperario(err) }
  }
}
