'use server'

import { revalidatePath } from 'next/cache'
import { ejecutarAccion, type ResultadoAccion } from '@/lib/acciones'
import { setAlmacenesForOperario } from '@/lib/admin/operarioAlmacenes'
import { registrarAuditoria } from '@/lib/audit'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { ErrorParaOperario } from '@/lib/errores'

/**
 * Saves the almacenes of an operario: the ones chosen replace all the ones they have, the links to almacenes that went
 * inactive included (see `setAlmacenesForOperario`, which refuses an almacén that is not active or already theirs).
 * The ids come from the client like everything else, and a value that is not a whole number would only come back from
 * the database as an error nobody can read.
 */
export async function updateAlmacenesAction(operarioId: string, almacenIds: number[]): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    const admin = await requireAdminFromCookies()
    if (!Array.isArray(almacenIds) || !almacenIds.every((id) => Number.isInteger(id) && id > 0)) {
      throw new ErrorParaOperario('Los almacenes elegidos no son válidos.')
    }

    const elegidos = [...new Set(almacenIds)].sort((a, b) => a - b)
    await setAlmacenesForOperario(operarioId, elegidos)
    await registrarAuditoria({
      operarioId: admin.id,
      accion: 'admin_almacenes',
      detalle: { operarioId, almacenIds: elegidos },
    })
    // The list of operarios shows the almacenes of each one.
    revalidatePath(`/admin/operarios/${operarioId}/almacenes`)
    revalidatePath('/admin/operarios')
  })
}
