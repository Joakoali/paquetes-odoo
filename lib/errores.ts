import type { ErrorTipo } from '../db/schema'
import { OdooError } from './odoo/client'

/**
 * An error whose `message` is written for the warehouse operator, so it can be
 * shown on screen as is. The message of any other error is technical.
 */
export class ErrorParaOperario extends Error {}

/**
 * Something an admin has to set up is missing (an env var, an almacén or
 * courier without its Odoo id). Retrying can't fix it.
 */
export class ConfiguracionError extends ErrorParaOperario {}

/**
 * Odoo answered with 2xx but not with what the code expects (e.g. a wizard
 * action where `true` was expected). Technical message: not for the operator.
 */
export class RespuestaOdooInesperadaError extends Error {}

/** Odoo, or the gateway in front of it, is overloaded or unreachable right now. */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504])

/**
 * Tells a failed Odoo sync that a retry can fix (`conexion`) from one that
 * needs a person: an admin (`configuracion`) or someone reading what Odoo
 * said (`odoo`).
 */
export function clasificarError(err: unknown): ErrorTipo {
  if (err instanceof ConfiguracionError) return 'configuracion'

  if (err instanceof OdooError) {
    // A 500 with no Odoo exception in its body is a gateway error page, not Odoo saying no.
    const transitorio = TRANSIENT_STATUSES.has(err.status) || (err.status === 500 && err.odooName === null)
    return transitorio ? 'conexion' : 'odoo'
  }

  if (err instanceof Error) {
    // fetch() rejects with a TimeoutError when our AbortSignal.timeout fires (AbortError for a
    // manual abort), and with TypeError('fetch failed') when it never reached the server.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'conexion'
    if (err instanceof TypeError && err.message.includes('fetch failed')) return 'conexion'
  }

  return 'odoo'
}

const MENSAJES_PROBLEMA: Record<ErrorTipo, string> = {
  configuracion: 'No se pudo enviar a Odoo: falta configuración. Lo tiene que arreglar el admin.',
  conexion: 'Odoo no respondió. Se reintentó solo y no hubo caso. Probá Reintentar en un rato.',
  odoo: 'Odoo rechazó el envío. Mirá el detalle o avisá al admin.',
}

/** What the operator reads next to a send that failed for good. */
export function mensajeProblema(tipo: ErrorTipo): string {
  return MENSAJES_PROBLEMA[tipo]
}
