'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { sesionCourierBatches, sesionItems, sesionesEscaneo } from '@/db/schema'
import { ejecutarAccion, type ResultadoAccion } from '@/lib/acciones'
import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { ForbiddenError } from '@/lib/auth/guards'
import {
  abrirRecepcion, borrarPaquete, descartarRecepcion, descartarSiVacia, enviarRecepcion, enviarRecepcionesAbiertas,
  escanearPaquete, EscaneoInvalidoError,
  type ResultadoEnvio, type ResultadoEscaneo,
} from '@/lib/recepcion/recepciones'

/**
 * These actions authenticate, check the almacén and translate errors; the work is in the domain,
 * which trusts its parameters. A recepción belongs to its almacén and not to who opened it, so
 * whoever has that almacén may work on it. The ids come from the client, like everything else: an
 * id that does not name a recepción (or a package of one) is treated as not existing, and that is
 * the case for the id of an entrega too.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const esUuid = (valor: unknown): valor is string => typeof valor === 'string' && UUID.test(valor)

/** The almacén of the recepción; null when there is no such recepción. */
async function almacenDeLaRecepcion(sesionId: string): Promise<number | null> {
  if (!esUuid(sesionId)) return null
  const sesion = await db.query.sesionesEscaneo.findFirst({
    columns: { almacenId: true },
    where: and(eq(sesionesEscaneo.id, sesionId), eq(sesionesEscaneo.tipo, 'recepcion')),
  })
  return sesion?.almacenId ?? null
}

/** The almacén of the recepción that has the package; null when no recepción has it. */
async function almacenDelPaquete(itemId: string): Promise<number | null> {
  if (!esUuid(itemId)) return null
  const [fila] = await db.select({ almacenId: sesionesEscaneo.almacenId })
    .from(sesionItems)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.id, sesionItems.courierBatchId))
    .innerJoin(sesionesEscaneo, eq(sesionesEscaneo.id, sesionCourierBatches.sesionId))
    .where(and(eq(sesionItems.id, itemId), eq(sesionesEscaneo.tipo, 'recepcion')))
  return fila?.almacenId ?? null
}

async function exigirAlmacen(operarioId: string, almacenId: number): Promise<void> {
  if (!(await operarioHasAlmacen(operarioId, almacenId))) {
    throw new ForbiddenError(`Operario sin acceso al almacén ${almacenId}`)
  }
}

/**
 * Whether the recepción exists, once the operario is known to have its almacén (ForbiddenError
 * if not). It is for the actions where a recepción that is already gone is not a failure but the
 * result the operario wanted, as it is in the domain.
 */
async function accederARecepcion(sesionId: string, operarioId: string): Promise<boolean> {
  const almacenId = await almacenDeLaRecepcion(sesionId)
  if (almacenId === null) return false
  await exigirAlmacen(operarioId, almacenId)
  return true
}

/** The same, for what cannot be done to a recepción that is not there. */
async function exigirRecepcion(sesionId: string, operarioId: string): Promise<void> {
  if (!(await accederARecepcion(sesionId, operarioId))) throw new EscaneoInvalidoError('La recepción no existe.')
}

/** Opens (or joins) the recepción of the barco in the active almacén. */
export async function abrirRecepcionAction(barcoOdooId: number): Promise<ResultadoAccion<{ sesionId: string }>> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    const almacen = await requireAlmacenActivo(operario.id)
    const sesionId = await abrirRecepcion({ almacenId: almacen.id, barcoOdooId, operarioId: operario.id })
    return { sesionId }
  })
}

/** Adds a scanned code to the recepción. It revalidates nothing: every scan has to stay light. */
export async function escanearAction(entrada: {
  sesionId: string
  courierId: number
  trackingNumber: string
}): Promise<ResultadoAccion<ResultadoEscaneo>> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    await exigirRecepcion(entrada.sesionId, operario.id)
    // Field by field: the operario is the one of the session, whatever else the client sent along.
    return escanearPaquete({
      sesionId: entrada.sesionId,
      courierId: entrada.courierId,
      trackingNumber: entrada.trackingNumber,
      operarioId: operario.id,
    })
  })
}

/** Takes a package out of its recepción. One that is already gone is nothing to delete. */
export async function borrarPaqueteAction(itemId: string): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    const almacenId = await almacenDelPaquete(itemId)
    if (almacenId === null) return
    await exigirAlmacen(operario.id, almacenId)
    await borrarPaquete(itemId)
  })
}

export async function enviarRecepcionAction(sesionId: string): Promise<ResultadoAccion<ResultadoEnvio>> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    await exigirRecepcion(sesionId, operario.id)
    const resultado = await enviarRecepcion({ sesionId, operarioId: operario.id })
    revalidatePath('/recepcion')
    return resultado
  })
}

/** Sends every open recepción of the active almacén that has something to send. */
export async function enviarTodasAction(): Promise<ResultadoAccion<{ enviadas: number }>> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    const almacen = await requireAlmacenActivo(operario.id)
    try {
      const enviadas = await enviarRecepcionesAbiertas({ almacenId: almacen.id, operarioId: operario.id })
      return { enviadas }
    } finally {
      // Also when it stops halfway: the recepciones sent before the failure are not in the lists any more.
      revalidatePath('/recepcion')
    }
  })
}

/**
 * Throws the recepción away with whatever is in it. It is what the operario asked for and confirmed;
 * the automatic cleanup of an empty one is `descartarSiVaciaAction`. One that is already gone is discarded already.
 */
export async function descartarRecepcionAction(sesionId: string): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    if (await accederARecepcion(sesionId, operario.id)) {
      await descartarRecepcion({ sesionId, operarioId: operario.id })
    }
    revalidatePath('/recepcion')
  })
}

/**
 * Throws the recepción away only if it has no package at all, and says whether it did. It is the
 * cleanup for a recepción that merely looks empty: recepciones are shared, and a package a colleague
 * has just scanned must not go with it, as it would with `descartarRecepcionAction`.
 */
export async function descartarSiVaciaAction(sesionId: string): Promise<ResultadoAccion<{ descartada: boolean }>> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    if (!(await accederARecepcion(sesionId, operario.id))) return { descartada: false }
    const descartada = await descartarSiVacia({ sesionId, operarioId: operario.id })
    if (descartada) revalidatePath('/recepcion')
    return { descartada }
  })
}

/** Scans a package into the recepción of a barco in the active almacén, which is opened if there is none. */
export async function asignarYEscanearAction(entrada: {
  barcoOdooId: number
  courierId: number
  trackingNumber: string
}): Promise<ResultadoAccion<{ sesionId: string; resultado: ResultadoEscaneo }>> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    const almacen = await requireAlmacenActivo(operario.id)
    const sesionId = await abrirRecepcion({
      almacenId: almacen.id,
      barcoOdooId: entrada.barcoOdooId,
      operarioId: operario.id,
    })
    const resultado = await escanearPaquete({
      sesionId,
      courierId: entrada.courierId,
      trackingNumber: entrada.trackingNumber,
      operarioId: operario.id,
    })
    return { sesionId, resultado }
  })
}
