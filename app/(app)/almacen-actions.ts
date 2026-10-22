'use server'

import { cookies } from 'next/headers'
import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import { ejecutarAccion, type ResultadoAccion } from '@/lib/acciones'
import { ALMACEN_COOKIE } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { ForbiddenError } from '@/lib/auth/guards'

const UN_ANIO_EN_SEGUNDOS = 60 * 60 * 24 * 365

/**
 * Makes `almacenId` the almacén this device works in. Setting the cookie is what makes Next render
 * the current page again, so the screens that were showing the old almacén show the new one.
 */
export async function elegirAlmacenAction(almacenId: number): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    // The id comes from the client: something that is not an id cannot be an almacén of the operario either.
    if (!Number.isInteger(almacenId) || !(await operarioHasAlmacen(operario.id, almacenId))) {
      throw new ForbiddenError(`Operario sin acceso al almacén ${String(almacenId)}`)
    }

    const store = await cookies()
    store.set(ALMACEN_COOKIE, String(almacenId), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: UN_ANIO_EN_SEGUNDOS,
    })
  })
}
