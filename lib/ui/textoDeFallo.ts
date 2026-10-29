import type { ResultadoAccion } from '@/lib/acciones'

/**
 * What a button says when its call got no answer at all. Written for the operario: it says what to do.
 * This module is imported by client components, so it can only `import type` from lib/acciones.ts, which
 * is server-only (it reaches the database through the auth guards).
 */
export const SIN_RESPUESTA = 'No hubo respuesta del servidor. Revisá la conexión y probá de nuevo.'

/**
 * Makes the call of a server action and gives back what it answered. The failures the action expects (an
 * expired session, no access, a recepción that was already sent) come back as `{ ok: false, error }` with the
 * text already written for the operario.
 *
 * The call itself can fail as well: the connection of a tablet drops, or the action belongs to an older
 * deploy and no longer exists. That is as expected here as any other failure, and it must not take the whole
 * screen down to the error page (a transition that throws goes there, and so does an event handler that
 * rejects while a scan is being checked), so it is answered as one more failure, with `SIN_RESPUESTA`. It is
 * logged, so that it can still be looked at.
 */
export async function llamarAccion<T>(llamada: () => Promise<ResultadoAccion<T>>): Promise<ResultadoAccion<T>> {
  try {
    return await llamada()
  } catch (error) {
    console.error('Server action could not be called', error)
    return { ok: false, error: SIN_RESPUESTA }
  }
}

/**
 * Whether the call got no answer at all (what `llamarAccion` gives back for a call that failed), and not an answer
 * that says something did not work. Only then is it unknown what the action did on the server: an action that
 * answered has already brought the screen up to date if it revalidated.
 */
export function sinRespuesta(resultado: ResultadoAccion<unknown>): boolean {
  return !resultado.ok && resultado.error === SIN_RESPUESTA
}

/**
 * Runs a server action on a sesión and gives back the text to show next to the button if it did not work,
 * or null if it did. For the buttons that only need to know that: the ones that need what the action
 * answered use `llamarAccion`.
 */
export async function textoDeFallo(
  accion: (sesionId: string) => Promise<ResultadoAccion<unknown>>,
  sesionId: string,
): Promise<string | null> {
  const resultado = await llamarAccion(() => accion(sesionId))
  return resultado.ok ? null : resultado.error
}
