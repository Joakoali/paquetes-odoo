import type { ResultadoAccion } from '@/lib/acciones'

/**
 * What a button says when its call got no answer at all. Written for the operario: it says what to do.
 * This module is imported by a client component, so it can only `import type` from lib/acciones.ts, which
 * is server-only (it reaches the database through the auth guards).
 */
export const SIN_RESPUESTA = 'No hubo respuesta del servidor. Revisá la conexión y probá de nuevo.'

/**
 * Runs a server action on a sesión and gives back the text to show next to the button if it did not work,
 * or null if it did. The action answers a `ResultadoAccion` and the failures it expects (an expired session,
 * no access, a queue that is down) come back as `{ ok: false, error }` with the text already written for the
 * operario: that text is what is shown.
 *
 * The call itself can fail as well: the connection of a tablet drops, or the action belongs to an older
 * deploy and no longer exists. That is as expected here as any other failure, and it must not take the whole
 * screen down to the error page (a transition that throws goes there), so it is a message too. It is logged,
 * so that it can still be looked at.
 */
export async function textoDeFallo(
  accion: (sesionId: string) => Promise<ResultadoAccion>,
  sesionId: string,
): Promise<string | null> {
  try {
    const resultado = await accion(sesionId)
    return resultado.ok ? null : resultado.error
  } catch (error) {
    console.error('Server action could not be called', error)
    return SIN_RESPUESTA
  }
}
