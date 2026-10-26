import type { ErrorTipo } from '../db/schema'

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

const FALLBACK_PREFIX = 'Odoo call failed: '
/** The message ends up in `ultimoError` and in "Ver detalle": a gateway error page must not flood it. */
const MAX_DETAIL_CHARS = 500

/** `key` of an Odoo answer body when it is a non-empty string, else null. */
function textField(data: unknown, key: 'name' | 'message'): string | null {
  if (typeof data !== 'object' || data === null) return null
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** The JSON of the answer, cut to MAX_DETAIL_CHARS with an ellipsis where it was cut. */
function describeAnswer(data: unknown): string {
  const json = String(JSON.stringify(data)) // JSON.stringify(undefined) is undefined, not a string
  return json.length > MAX_DETAIL_CHARS ? `${json.slice(0, MAX_DETAIL_CHARS - 1)}…` : json
}

/**
 * A non-2xx answer from Odoo, or a 2xx whose body is not JSON. `data` is what
 * came back, whole: the parsed JSON, the raw text when it was not JSON (a proxy
 * error page), or null for an empty body. `message` is the one Odoo sends or,
 * failing that, `Odoo call failed: <json>` cut to 500 characters of JSON.
 * `odooName` is the exception Odoo reports (`odoo.exceptions.UserError`, …); it
 * is only there when Odoo itself answered, which is how a rejected request is
 * told apart from a gateway error.
 *
 * Defined here and not in `odoo/client.ts` (which re-exports it) because
 * `odooCall` throws `ConfiguracionError`: if this module imported the client
 * back, the two would import each other.
 */
export class OdooError extends Error {
  readonly status: number
  readonly odooName: string | null
  readonly data: unknown

  constructor(info: { status: number; data: unknown }) {
    super(textField(info.data, 'message') ?? `${FALLBACK_PREFIX}${describeAnswer(info.data)}`)
    this.status = info.status
    this.odooName = textField(info.data, 'name')
    this.data = info.data
  }
}

/**
 * Request timeout, throttling or a server-side failure: Odoo, or the gateway in
 * front of it, can answer the same request later. A 5xx whose body names an Odoo
 * exception (a UserError raised on a 500, say) is Odoo answering "no" instead.
 */
function isTransient(err: OdooError): boolean {
  if (err.status === 408 || err.status === 429) return true
  return err.status >= 500 && err.status < 600 && err.odooName === null
}

/**
 * Odoo refused the credentials (401: the API key is wrong or was revoked) or the user they belong to may not do
 * what was asked (403: it lacks the access rights). Nothing in the sesión can fix that: whoever looks after the
 * Odoo user and the key has to, so it is a matter of configuration like a missing env var.
 */
function isRefusedAccess(err: OdooError): boolean {
  return err.status === 401 || err.status === 403
}

/**
 * Tells a failed Odoo sync that a retry can fix (`conexion`) from one that
 * needs a person: an admin (`configuracion`: a setup that is missing, or
 * credentials or rights that Odoo refuses) or someone reading what Odoo said
 * (`odoo`).
 */
export function clasificarError(err: unknown): ErrorTipo {
  if (err instanceof ConfiguracionError) return 'configuracion'

  if (err instanceof OdooError) {
    if (isRefusedAccess(err)) return 'configuracion'
    return isTransient(err) ? 'conexion' : 'odoo'
  }

  if (err instanceof Error) {
    // fetch() rejects with a TimeoutError when our AbortSignal.timeout fires (AbortError for a
    // manual abort), and with TypeError('fetch failed') when it never reached the server. Reading
    // the body rejects with TypeError('terminated') when the connection drops mid-response.
    // Any other TypeError is a bug in our code and must not be retried as if it were the network.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'conexion'
    if (err instanceof TypeError && /fetch failed|terminated/i.test(err.message)) return 'conexion'
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
