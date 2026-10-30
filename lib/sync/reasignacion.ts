import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, barcosCache, operarios, sesionesEscaneo } from '../../db/schema'
import { registrarAuditoria } from '../audit'
import { nombreDelBarco } from '../entrega/entregas'
import { ConfiguracionError } from '../errores'
import { odooCall } from '../odoo/client'
import { aplicarReasignacion, entregaDestino, planearReasignacion, type EntregaDeOdoo } from '../odoo/reasignacion'

/** How a list of packages reads in a note: the numbers, "sin número" for a line without lot. */
const listaDePaquetes = (trackingNumbers: Array<string | null>) => trackingNumbers.map((numero) => numero ?? 'sin número').join(', ')

/** Who, from where, to where: what every note of a reasignación says. */
interface Firma {
  operario: string
  barcoOrigen: string
  barcoDestino: string
}

/** The note left in the delivery that takes the packages. */
function notaDeLlegada(firma: Firma, entrada: { trackingNumbers: Array<string | null>; desde: string[] }): string {
  return `Se pasaron ${entrada.trackingNumbers.length} paquete(s) de ${firma.barcoOrigen} (${entrada.desde.join(', ')}) `
    + `vía Webapp Paquetería por ${firma.operario}: ${listaDePaquetes(entrada.trackingNumbers)}`
}

/** The note left in a delivery the packages leave, and that it was cancelled if it was left with nothing. */
function notaDeSalida(firma: Firma, entrada: { trackingNumbers: Array<string | null>; hacia: string; cancelada: boolean }): string {
  const nota = `Se pasaron ${entrada.trackingNumbers.length} paquete(s) a ${firma.barcoDestino} (${entrada.hacia}) `
    + `vía Webapp Paquetería por ${firma.operario}: ${listaDePaquetes(entrada.trackingNumbers)}`
  return entrada.cancelada ? `${nota}. La entrega quedó vacía y se canceló.` : nota
}

/** The note of a delivery an earlier attempt left with nothing, and this one cancelled. */
const notaDeCancelada = (firma: Firma) =>
  `La entrega quedó vacía al pasar sus paquetes a ${firma.barcoDestino} y se canceló (vía Webapp Paquetería por ${firma.operario}).`

/** The names of the two barcos, as the webapp has them. */
async function nombresDeBarcos(origen: number, destino: number): Promise<{ origen: string; destino: string }> {
  const filas = await db.select({ odooId: barcosCache.odooId, nombre: barcosCache.nombre })
    .from(barcosCache)
    .where(inArray(barcosCache.odooId, [origen, destino]))
  const nombres = new Map(filas.map((fila) => [fila.odooId, fila.nombre]))
  return { origen: nombreDelBarco(nombres.get(origen), origen), destino: nombreDelBarco(nombres.get(destino), destino) }
}

/**
 * THE single place a reasignación is pushed to Odoo. Called by the QStash single-consumer worker, one session at a time.
 * It moves the packages from the deliveries of the barco they were on to a delivery of the barco destino, in the
 * delivery type of the almacén (see lib/odoo/reasignacion.ts for how), and leaves a note in each delivery it touched.
 *
 * Everything that has to be read is read before anything is written, and the delivery that takes the packages is kept in
 * the session before any package is moved: a retry takes them to the same one. Idempotent: what is left to do is decided
 * by what Odoo has now, so a retry after a failure does only what the failed attempt did not. Each run notes what it did,
 * and only that: a run that finds everything done writes nothing in Odoo. It only acts on a reasignación that is
 * `confirmada_pendiente_sync`; for any other session it returns without calling Odoo or changing anything.
 */
export async function syncReasignacionSession(sesionId: string): Promise<void> {
  const sesion = await db.query.sesionesEscaneo.findFirst({ where: eq(sesionesEscaneo.id, sesionId) })
  if (!sesion) throw new Error(`Sesión ${sesionId} no encontrada`)
  // As with an entrega: a message can arrive for a session that is not waiting for its sync any more (QStash delivering a
  // finished run again, or a message from before a "Reintentar"), and a failure here would send a finished one to `error`.
  if (sesion.estado !== 'confirmada_pendiente_sync') return

  const almacen = await db.query.almacenes.findFirst({ where: eq(almacenes.id, sesion.almacenId) })
  if (!almacen?.odooOutTypeId) {
    throw new ConfiguracionError('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')
  }
  const outTypeId = almacen.odooOutTypeId

  const { barcoDestinoOdooId, odooMoveLineIds, paquetesDeOdoo } = sesion
  // The lines and their packages are saved together, in the order of the list they were chosen from.
  if (!barcoDestinoOdooId || !odooMoveLineIds || !paquetesDeOdoo || paquetesDeOdoo.length !== odooMoveLineIds.length) {
    throw new Error(`Sesión ${sesionId} no tiene barco destino, o sus líneas y sus paquetes no coinciden`)
  }

  // The notes name who moved the packages, and the barcos: ids mean nothing in Odoo.
  const [[operario], barcos] = await Promise.all([
    db.select({ nombre: operarios.nombre }).from(operarios).where(eq(operarios.id, sesion.operarioId)),
    nombresDeBarcos(sesion.barcoOdooId, barcoDestinoOdooId),
  ])
  if (!operario) throw new Error(`Operario ${sesion.operarioId} no encontrado`)
  const firma: Firma = { operario: operario.nombre, barcoOrigen: barcos.origen, barcoDestino: barcos.destino }

  const plan = await planearReasignacion({
    paquetes: odooMoveLineIds.map((moveLineId, posicion) => ({ moveLineId, trackingNumber: paquetesDeOdoo[posicion].trackingNumber })),
    outTypeId,
    barcoOrigenOdooId: sesion.barcoOdooId,
    barcoDestinoOdooId,
    entregasOrigenIds: sesion.odooPickingIds ?? [],
  })

  let destino: EntregaDeOdoo | null = null
  if (plan.lineas.length > 0) {
    destino = await entregaDestino({ outTypeId, barcoOdooId: barcoDestinoOdooId, guardadaId: sesion.odooPickingId })
    await db.update(sesionesEscaneo)
      .set({ odooPickingId: destino.id, odooPickingRef: destino.ref })
      .where(eq(sesionesEscaneo.id, sesionId))
  }

  const { canceladas } = await aplicarReasignacion(plan, destino?.id ?? null)

  const idsCanceladas = new Set(canceladas.map((entrega) => entrega.id))
  if (destino) {
    await odooCall('stock.picking', 'message_post', {
      ids: [destino.id],
      body: notaDeLlegada(firma, {
        trackingNumbers: plan.salidas.flatMap((salida) => salida.trackingNumbers),
        desde: plan.salidas.map((salida) => salida.entrega.ref),
      }),
    })
    for (const salida of plan.salidas) {
      await odooCall('stock.picking', 'message_post', {
        ids: [salida.entrega.id],
        body: notaDeSalida(firma, { trackingNumbers: salida.trackingNumbers, hacia: destino.ref, cancelada: idsCanceladas.has(salida.entrega.id) }),
      })
    }
  }
  // Those emptied by an earlier attempt, which this run only cancelled: the note of the packages is already there.
  const conSalida = new Set(plan.salidas.map((salida) => salida.entrega.id))
  for (const cancelada of canceladas.filter((entrega) => !conSalida.has(entrega.id))) {
    await odooCall('stock.picking', 'message_post', { ids: [cancelada.id], body: notaDeCancelada(firma) })
  }

  // A failure that an earlier attempt left behind (one QStash then retried) is over, and so is a review set for it.
  await db.update(sesionesEscaneo)
    .set({
      estado: 'sincronizada',
      syncedAt: new Date(),
      ultimoError: null,
      ultimoErrorTipo: null,
      revisadoAt: null,
      revisadoPor: null,
    })
    .where(eq(sesionesEscaneo.id, sesionId))

  await registrarAuditoria({
    operarioId: null,
    accion: 'sync_ok',
    detalle: { sesionId, odooPickingRef: destino?.ref ?? sesion.odooPickingRef },
  })
}
