import { db } from '../db/client'
import { auditLog } from '../db/schema'

/** What the app writes to `audit_log`. The column is plain text: the type keeps the names from drifting. */
export type AccionAuditoria =
  | 'recepcion_enviada'
  | 'recepcion_descartada'
  | 'entrega_confirmada'
  | 'reasignacion_confirmada'
  | 'sync_ok'
  | 'sync_error'
  | 'reintento'
  | 'revisado'
  | 'admin_operario_creado'
  | 'admin_operario_activo'
  | 'admin_almacenes'
  | 'admin_refresco'

/**
 * Leaves a line in `audit_log`: who (`operarioId`, null when nobody did it by hand: a
 * worker or a cron) did what, and whatever helps to understand it later.
 *
 * Never throws. The audit trail is a record of something that already happened, so failing to
 * write it must not undo or hide that: it is logged and the caller goes on.
 */
export async function registrarAuditoria(entrada: {
  operarioId: string | null
  accion: AccionAuditoria
  detalle?: Record<string, unknown>
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      operarioId: entrada.operarioId,
      accion: entrada.accion,
      detalle: entrada.detalle ?? null,
    })
  } catch (err) {
    console.error('audit_log write failed', { accion: entrada.accion, operarioId: entrada.operarioId, err })
  }
}
