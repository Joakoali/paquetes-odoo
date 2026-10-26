'use server'

import { ejecutarAccion, type ResultadoAccion } from '@/lib/acciones'
import { registrarAuditoria } from '@/lib/audit'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { publishRefreshMaestros, publishRefreshTrackings } from '@/lib/queue/publish'

/**
 * Enqueues an on-demand refresh of what is read from Odoo (almacenes, couriers, barcos and courier usage) and of the
 * tracking-number cache, both onto the odoo-sync queue: the page does not wait for them, they run when it is their
 * turn. The jobs leave their own line in the audit trail when they run, with nobody as the operario; this one says who
 * asked for them.
 */
export async function refrescarDatosOdooAction(): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    const admin = await requireAdminFromCookies()
    await publishRefreshMaestros()
    await publishRefreshTrackings()
    await registrarAuditoria({
      operarioId: admin.id,
      accion: 'admin_refresco',
      detalle: { encolado: ['maestros', 'trackings'] },
    })
  })
}
