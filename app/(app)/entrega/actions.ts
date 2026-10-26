'use server'

import { revalidatePath } from 'next/cache'
import { ejecutarAccion, type ResultadoAccion } from '@/lib/acciones'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { registrarEntrega } from '@/lib/entrega/entregas'
import { ErrorParaOperario } from '@/lib/errores'
import { enviarRecepcionesAbiertas } from '@/lib/recepcion/recepciones'
import { MAX_NOMBRE_RECEPTOR } from '@/lib/ui/seleccion-entrega'

/**
 * These actions authenticate, check the almacén and translate errors; the work is in the domain, which trusts its
 * parameters. An entrega is made in the almacén the operario is working in: it is the active one, as for every
 * action on the delivery screens.
 */

/** What a canvas gives for a signature: `data:image/png;base64,` and then the image. Odoo is given what comes after it. */
const FIRMA_PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/

/** What the screen already makes sure of (the button is not enabled without it): this is for whoever calls the action without the screen. */
function validarConfirmacion(
  entrada: { receptorNombre: string; pickingIds: number[]; moveLineIds: number[]; firmaDataUrl: string },
): string {
  const receptor = typeof entrada.receptorNombre === 'string' ? entrada.receptorNombre.trim() : ''
  if (receptor === '') throw new ErrorParaOperario('Falta el nombre de quien recibe.')
  if (receptor.length > MAX_NOMBRE_RECEPTOR) throw new ErrorParaOperario('El nombre de quien recibe es demasiado largo.')
  // Lines with no delivery to touch would be "registered" and then do nothing in Odoo.
  const sinPaquetes = (ids: unknown) => !Array.isArray(ids) || ids.length === 0
  if (sinPaquetes(entrada.moveLineIds) || sinPaquetes(entrada.pickingIds)) throw new ErrorParaOperario('Elegí al menos un paquete.')
  if (typeof entrada.firmaDataUrl !== 'string' || !FIRMA_PNG.test(entrada.firmaDataUrl)) throw new ErrorParaOperario('Falta la firma.')
  return receptor
}

/**
 * Registers the entrega the crew confirmed and queues it. `id` is made up by the phone before its first try and is
 * what makes a retry harmless: the domain saves the entrega once per id, whatever the number of tries.
 */
export async function confirmarEntregaAction(entrada: {
  id: string
  barcoOdooId: number
  pickingIds: number[]
  moveLineIds: number[]
  receptorNombre: string
  firmaDataUrl: string
}): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    const almacen = await requireAlmacenActivo(operario.id)
    const receptorNombre = validarConfirmacion(entrada)
    // Field by field: the operario and the almacén are the ones of the session, whatever else the client sent along.
    await registrarEntrega({
      id: entrada.id,
      operarioId: operario.id,
      almacenId: almacen.id,
      barcoOdooId: entrada.barcoOdooId,
      pickingIds: entrada.pickingIds,
      moveLineIds: entrada.moveLineIds,
      receptorNombre,
      firmaBase64: entrada.firmaDataUrl,
    })
    revalidatePath('/entrega')
  })
}

/**
 * Sends the open recepciones of the barco in the active almacén, so that the packages they hold get to Odoo and can be
 * delivered. It says how many recepciones it sent.
 */
export async function enviarRecepcionesDelBarcoAction(barcoOdooId: number): Promise<ResultadoAccion<{ enviadas: number }>> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    const almacen = await requireAlmacenActivo(operario.id)
    try {
      const enviadas = await enviarRecepcionesAbiertas({ almacenId: almacen.id, operarioId: operario.id, barcoOdooId })
      return { enviadas }
    } finally {
      // Also when it stops halfway: the recepciones sent before the failure are not open, nor unsent, any more.
      revalidatePath('/entrega')
      revalidatePath('/recepcion')
    }
  })
}
