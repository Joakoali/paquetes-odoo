'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { sesionesEscaneo, type Operario } from '@/db/schema'
import { ejecutarAccion, type ResultadoAccion } from '@/lib/acciones'
import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { ForbiddenError } from '@/lib/auth/guards'
import { marcarRevisado, reintentar } from '@/lib/sync/pendientes'

/**
 * These actions authenticate, check access and translate errors; the work is in the domain, which trusts its
 * parameters. The admin may act on any sesión. An operario only on those of an almacén they have, whatever almacén
 * they are working in at the moment, since a problem belongs to the almacén it happened in: so an id that names no
 * sesión is refused for them, as there is no almacén to check. The id comes from the client like everything else,
 * and anything that is not even the id of a sesión is refused for everybody, the admin included.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Postgres would refuse anything else as an id, with an error that is logged and read as "Algo falló". */
const esUuid = (valor: unknown): valor is string => typeof valor === 'string' && UUID.test(valor)

async function exigirAcceso(operario: Operario, sesionId: string): Promise<void> {
  if (!esUuid(sesionId)) throw new ForbiddenError('Not the id of a sesión')
  if (operario.rol === 'admin') return

  const sesion = await db.query.sesionesEscaneo.findFirst({
    columns: { almacenId: true },
    where: eq(sesionesEscaneo.id, sesionId),
  })
  if (!sesion || !(await operarioHasAlmacen(operario.id, sesion.almacenId))) {
    throw new ForbiddenError(`Operario sin acceso a la sesión ${sesionId}`)
  }
}

/** What both actions do: check access, run the domain function for the operario of the session, refresh the screen. */
function sobreLaSesion(
  sesionId: string,
  trabajo: (operario: Operario) => Promise<void>,
): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    await exigirAcceso(operario, sesionId)
    await trabajo(operario)
    // Also when the domain had nothing to do: a screen that is out of date shows what is there now.
    revalidatePath('/pendientes')
  })
}

/** Puts a failed or stuck send back in the queue. */
export async function reintentarAction(sesionId: string): Promise<ResultadoAccion> {
  return sobreLaSesion(sesionId, (operario) => reintentar({ sesionId, operarioId: operario.id }))
}

/**
 * Marks a duplicado as looked at, or, for the admin, a failed send as resolved, so it stops being listed. Anything
 * else is left as it is: see `marcarRevisado`. Whether the caller is the admin comes from their session, never from
 * the client, which sends nothing but the id.
 */
export async function marcarRevisadoAction(sesionId: string): Promise<ResultadoAccion> {
  return sobreLaSesion(sesionId, (operario) => marcarRevisado({
    sesionId, operarioId: operario.id, esAdmin: operario.rol === 'admin',
  }))
}
