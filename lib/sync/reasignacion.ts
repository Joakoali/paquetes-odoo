import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, barcosCache, operarios, sesionesEscaneo, type PaqueteDeOdoo, type SesionEscaneo } from '../../db/schema'
import { registrarAuditoria } from '../audit'
import { nombreDelBarco } from '../entrega/entregas'
import { ConfiguracionError } from '../errores'
import { odooCall } from '../odoo/client'
import {
  aplicarReasignacion, entregaDestino, planearReasignacion, type EntregaDeOdoo, type EntregaDeOrigen,
} from '../odoo/reasignacion'

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

/** The note of a delivery this run cancelled, empty, that the packages were not on when the reasignación was confirmed. */
const notaDeCancelada = (firma: Firma) =>
  `La entrega quedó vacía al pasar sus paquetes a ${firma.barcoDestino} y se canceló (vía Webapp Paquetería por ${firma.operario}).`

/** What the notes of a reasignación say, and where they go. */
interface Anotacion {
  firma: Firma
  /** The delivery that took the packages. */
  llegada: EntregaDeOdoo
  /** What the reasignación moved, as it was confirmed: each package with the delivery it was on. */
  paquetes: PaqueteDeOdoo[]
  /** The deliveries the packages were on when it was confirmed, as Odoo has them now. */
  origenes: EntregaDeOrigen[]
  /** The deliveries this run cancelled because they were left with nothing. */
  canceladas: EntregaDeOdoo[]
}

/**
 * Leaves the notes of the reasignación in Odoo: on the delivery that took the packages, and on each delivery they were on
 * when it was confirmed, saying what the sesión moved and not what this run did. Every run that ends the sync writes them,
 * so a run cut after the packages moved and before its notes leaves them to the retry, which has nothing left to move. A
 * run cut between two notes leaves the first one written twice: better twice than not at all.
 *
 * A delivery this run cancelled that the packages were not on when it was confirmed (a backorder their lines went to)
 * gets a note of its own, so that nobody finds it cancelled without a word.
 */
async function anotar({ firma, llegada, paquetes, origenes, canceladas }: Anotacion): Promise<void> {
  const refs = [...new Set(paquetes.map((paquete) => paquete.pickingRef))]
  const enviar = (pickingId: number, body: string) => odooCall('stock.picking', 'message_post', { ids: [pickingId], body })

  await enviar(llegada.id, notaDeLlegada(firma, { trackingNumbers: paquetes.map((paquete) => paquete.trackingNumber), desde: refs }))

  const idsCanceladas = new Set(canceladas.map((entrega) => entrega.id))
  const porRef = new Map(origenes.map((origen) => [origen.ref, origen]))
  for (const ref of refs) {
    const origen = porRef.get(ref)
    if (!origen) continue
    await enviar(origen.id, notaDeSalida(firma, {
      trackingNumbers: paquetes.filter((paquete) => paquete.pickingRef === ref).map((paquete) => paquete.trackingNumber),
      hacia: llegada.ref,
      cancelada: origen.cancelada || idsCanceladas.has(origen.id),
    }))
  }

  const deOrigen = new Set(origenes.map((origen) => origen.id))
  for (const cancelada of canceladas.filter((entrega) => !deOrigen.has(entrega.id))) {
    await enviar(cancelada.id, notaDeCancelada(firma))
  }
}

/** The delivery an earlier run took for the packages and kept before it moved them, if one did. */
function entregaGuardada(sesion: Pick<SesionEscaneo, 'odooPickingId' | 'odooPickingRef'>): EntregaDeOdoo | null {
  return sesion.odooPickingId !== null && sesion.odooPickingRef !== null ? { id: sesion.odooPickingId, ref: sesion.odooPickingRef } : null
}

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
 * by what Odoo has now, so a retry after a failure does only what the failed attempt did not, and then writes the notes
 * (see `anotar`). It only acts on a reasignación that is `confirmada_pendiente_sync`; for any other session it returns
 * without calling Odoo or changing anything.
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

  // Where the packages went: this run's delivery, or the one an earlier run kept before it moved them. None when the
  // webapp moved nothing (somebody had already put them on the destino in Odoo), and then there is nothing to note.
  const llegada = destino ?? entregaGuardada(sesion)
  if (llegada) await anotar({ firma, llegada, paquetes: paquetesDeOdoo, origenes: plan.entregasOrigen, canceladas })

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
