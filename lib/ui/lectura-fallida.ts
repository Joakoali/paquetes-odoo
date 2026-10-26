import { clasificarError, ErrorParaOperario, OdooError } from '@/lib/errores'

/** What the operario reads when a screen could not read what it needs from Odoo. Not what Odoo said: that is for the logs. */
export const LECTURA_DE_ODOO_FALLIDA = 'No se pudo leer de Odoo. Probá de nuevo en un rato.'

/**
 * What a screen that reads from Odoo says when the reading failed, or null when the failure is not one to show: a bug,
 * which has to reach the error screen of the app with its digest, not be hidden behind a message that says "try again".
 *
 * - What is written for the operario (`ErrorParaOperario`: a missing configuration, for one) is said as it is.
 * - Odoo answering with an error, or not answering (a timeout, no connection), is `LECTURA_DE_ODOO_FALLIDA`.
 */
export function mensajeDeLecturaFallida(error: unknown): string | null {
  if (error instanceof ErrorParaOperario) return error.message
  if (error instanceof OdooError || clasificarError(error) === 'conexion') return LECTURA_DE_ODOO_FALLIDA
  return null
}
