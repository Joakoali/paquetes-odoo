import { eq, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { sesionesEscaneo, type ErrorTipo } from '../../db/schema'
import { registrarAuditoria } from '../audit'
import { clasificarError, OdooError } from '../errores'
import { MAX_REINTENTOS } from '../queue/publish'

/**
 * What `ultimoError` keeps, and so what "Ver detalle" shows. An OdooError says which HTTP
 * status Odoo answered with, because its own message no longer carries it; any other error
 * (a ConfiguracionError, a network TypeError) is just its message.
 */
function textoDelError(error: unknown): string {
  if (error instanceof OdooError) return `Odoo HTTP ${error.status}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/**
 * Notes that a sync of the session failed and tells the caller whether QStash should try again.
 *
 * Every failure counts as an attempt and leaves its message and type in the session. It is
 * `final` when no retry can fix it (anything but `conexion`) or when QStash has already
 * retried as many times as it was told to (`MAX_REINTENTOS`): then the session moves to
 * `error`, which is what puts it in Pendientes. If it is not final the state stays as it
 * was and the session keeps waiting for the next delivery.
 */
export async function registrarFalloSync(entrada: {
  sesionId: string
  error: unknown
  /** The `Upstash-Retried` header: 0 on the first delivery of the message. */
  reintentosHechos: number
}): Promise<{ final: boolean; tipo: ErrorTipo }> {
  const tipo = clasificarError(entrada.error)
  const final = tipo !== 'conexion' || entrada.reintentosHechos >= MAX_REINTENTOS
  const mensaje = textoDelError(entrada.error)

  await db.update(sesionesEscaneo)
    .set({
      intentos: sql`${sesionesEscaneo.intentos} + 1`,
      ultimoError: mensaje,
      ultimoErrorTipo: tipo,
      ...(final ? { estado: 'error' as const } : {}),
    })
    .where(eq(sesionesEscaneo.id, entrada.sesionId))

  await registrarAuditoria({
    operarioId: null,
    accion: 'sync_error',
    detalle: { sesionId: entrada.sesionId, tipo, final, reintentosHechos: entrada.reintentosHechos, error: mensaje },
  })

  return { final, tipo }
}
