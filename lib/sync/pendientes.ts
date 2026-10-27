import { and, asc, count, eq, exists, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import {
  almacenes, barcosCache, operarios, sesionCourierBatches, sesionItems, sesionesEscaneo,
  type ErrorTipo, type Operario, type SesionEscaneo,
} from '../../db/schema'
import { getAlmacenesForOperario } from '../admin/operarioAlmacenes'
import { registrarAuditoria } from '../audit'
import { mensajeProblema } from '../errores'
import { publishSync } from '../queue/publish'

/**
 * Pendientes is where the sesiones that did not end well are looked at, by the admin and by any operario
 * for the almacenes they have. These functions trust their parameters: who may see or touch which almacén is
 * decided by the screen and the server actions that call them.
 */

/** How long a send may wait for its sync before it counts as stuck. */
export const MINUTOS_TRABADO = 15

/**
 * `error`: the sync failed for good. `trabado`: the send has waited for its sync for longer than
 * MINUTOS_TRABADO (the message was lost, or the queue is not getting to it). `duplicado`: the recepción synced,
 * but some packages were left out because Odoo already had them when it was sent.
 */
export type TipoProblema = 'error' | 'trabado' | 'duplicado'

/** Which almacenes a screen may look at: these, or all of them (what the admin sees). */
export type Alcance = { almacenIds: number[] } | 'todos'

export interface Problema {
  sesionId: string
  tipo: TipoProblema
  sesionTipo: 'recepcion' | 'entrega'
  almacenPrefijo: string
  barcoNombre: string
  /** Who opened the recepción, or confirmed the entrega. */
  operarioNombre: string
  /** When it was sent: what "hace 3 h" counts from. */
  fecha: Date
  /**
   * The packages the problem is about, in the order they were scanned, each with the picking where Odoo already
   * had it (`ref`) when it did. For an `error` or a `trabado` they are all the recepción's, since the whole
   * recepción is what failed; for a `duplicado`, only those left out. An entrega has none of its own: it is
   * described by `entrega`.
   */
  paquetes: Array<{ trackingNumber: string; ref: string | null }>
  /**
   * What an entrega says of the packages it covers, since it has no tracking numbers to list: how many the crew
   * was given and the name of who received them. Null for a recepción.
   */
  entrega: { paquetes: number; receptorNombre: string | null } | null
  /** What happened and what to do, in words for the operator. */
  mensaje: string
  /** The technical error, for "Ver detalle". */
  detalle: string | null
  /** A configuration error: retrying will not fix it, somebody with access to the setup has to. */
  loArreglaElAdmin: boolean
}

const MENSAJE_TRABADO = `Lleva más de ${MINUTOS_TRABADO} minutos enviándose. Probá Reintentar.`
const MENSAJE_DUPLICADO = 'Estos paquetes ya estaban en Odoo y no se cargaron de nuevo. Revisá que no sea un error.'

function mensajeDe(tipo: TipoProblema, ultimoErrorTipo: ErrorTipo | null): string {
  if (tipo === 'trabado') return MENSAJE_TRABADO
  if (tipo === 'duplicado') return MENSAJE_DUPLICADO
  return mensajeProblema(ultimoErrorTipo ?? 'odoo')
}

function tipoDeProblema(estado: SesionEscaneo['estado']): TipoProblema {
  switch (estado) {
    case 'error': return 'error'
    case 'confirmada_pendiente_sync': return 'trabado'
    case 'sincronizada': return 'duplicado'
    // Not reachable: `esProblema` lets through no sesión that is still open.
    case 'en_curso': throw new Error('A sesión that is still open is not a problem')
  }
}

/**
 * A recepción that synced and left a package out because Odoo already had it when it was sent, and that nobody has
 * reviewed. Anybody can review it. A duplicado found while scanning (`duplicadoAlEnviar` false) is not one: the
 * operario saw it on the spot.
 *
 * As a WHERE, for the list, the count and the review at once, so that what is listed and what can be reviewed
 * are the same thing and can never disagree: a review can only be set on a sesión that is a duplicado now.
 */
function esDuplicadoSinRevisar() {
  const conPaqueteDejadoAfuera = exists(
    db.select({ uno: sql`1` })
      .from(sesionCourierBatches)
      .innerJoin(sesionItems, eq(sesionItems.courierBatchId, sesionCourierBatches.id))
      .where(and(eq(sesionCourierBatches.sesionId, sesionesEscaneo.id), eq(sesionItems.duplicadoAlEnviar, true))),
  )
  return and(eq(sesionesEscaneo.estado, 'sincronizada'), conPaqueteDejadoAfuera, isNull(sesionesEscaneo.revisadoAt))
}

/**
 * A send that failed for good and that the admin has not marked as resolved. A failed send is not in Odoo and
 * leaves Pendientes when it is retried and synced; the mark is for those that never will (a picking somebody
 * cancelled in Odoo, a package that is not on the delivery any more), and only the admin can set it.
 *
 * As a WHERE, for the list, the count and the mark at once, for the same reason as `esDuplicadoSinRevisar`.
 */
function esErrorSinResolver() {
  return and(eq(sesionesEscaneo.estado, 'error'), isNull(sesionesEscaneo.revisadoAt))
}

/**
 * What makes a sesión a problem, as the WHERE of a query, for the list and for the count at once so that the
 * two can never disagree. A sesión is one if it is in the scope and it is in `error` and nobody has marked it as
 * resolved; or waiting for its sync since before the stuck limit; or a duplicado nobody has reviewed. A review
 * does not hide a stuck send, even if one is there: it leaves by being retried and synced.
 */
function esProblema(alcance: Alcance, ahora: Date) {
  const limiteDeTrabado = new Date(ahora.getTime() - MINUTOS_TRABADO * 60_000)

  return and(
    // An empty list of almacenes matches nothing.
    alcance === 'todos' ? undefined : inArray(sesionesEscaneo.almacenId, alcance.almacenIds),
    or(
      esErrorSinResolver(),
      and(eq(sesionesEscaneo.estado, 'confirmada_pendiente_sync'), lt(sesionesEscaneo.confirmedAt, limiteDeTrabado)),
      esDuplicadoSinRevisar(),
    ),
  )
}

interface PaqueteDeSesion {
  trackingNumber: string
  ref: string | null
  dejadoAfueraAlEnviar: boolean
}

/** The packages of each sesión, in the order they were scanned (the id last, so that a tie never changes between reads). */
async function paquetesDeLasSesiones(sesionIds: string[]): Promise<Map<string, PaqueteDeSesion[]>> {
  const filas = await db.select({
    sesionId: sesionCourierBatches.sesionId,
    trackingNumber: sesionItems.trackingNumber,
    ref: sesionItems.duplicadoRef,
    dejadoAfueraAlEnviar: sesionItems.duplicadoAlEnviar,
  })
    .from(sesionItems)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.id, sesionItems.courierBatchId))
    .where(inArray(sesionCourierBatches.sesionId, sesionIds))
    .orderBy(asc(sesionItems.createdAt), asc(sesionItems.id))

  const porSesion = new Map<string, PaqueteDeSesion[]>()
  for (const { sesionId, ...paquete } of filas) {
    porSesion.set(sesionId, [...(porSesion.get(sesionId) ?? []), paquete])
  }
  return porSesion
}

const ORDEN_DE_TIPOS: Record<TipoProblema, number> = { error: 0, trabado: 1, duplicado: 2 }

/** The failures first, then the stuck sends, then the duplicados; the oldest first in each group, and by id when the moment is the same. */
function porUrgencia(a: Problema, b: Problema): number {
  if (a.tipo !== b.tipo) return ORDEN_DE_TIPOS[a.tipo] - ORDEN_DE_TIPOS[b.tipo]
  if (a.fecha.getTime() !== b.fecha.getTime()) return a.fecha.getTime() - b.fecha.getTime()
  return a.sesionId < b.sesionId ? -1 : 1
}

/**
 * The problems to look at in the scope, the failures first, then the stuck sends, then the duplicados, the
 * oldest first in each group. Those that were already reviewed are not in it. `ahora` decides what is stuck.
 */
export async function listarProblemas(alcance: Alcance, ahora: Date = new Date()): Promise<Problema[]> {
  const sesiones = await db.select({
    id: sesionesEscaneo.id,
    tipo: sesionesEscaneo.tipo,
    estado: sesionesEscaneo.estado,
    ultimoError: sesionesEscaneo.ultimoError,
    ultimoErrorTipo: sesionesEscaneo.ultimoErrorTipo,
    confirmedAt: sesionesEscaneo.confirmedAt,
    createdAt: sesionesEscaneo.createdAt,
    odooMoveLineIds: sesionesEscaneo.odooMoveLineIds,
    receptorNombre: sesionesEscaneo.receptorNombre,
    barcoOdooId: sesionesEscaneo.barcoOdooId,
    barcoNombre: barcosCache.nombre,
    almacenPrefijo: almacenes.prefijo,
    operarioNombre: operarios.nombre,
  })
    .from(sesionesEscaneo)
    .innerJoin(almacenes, eq(almacenes.id, sesionesEscaneo.almacenId))
    .innerJoin(operarios, eq(operarios.id, sesionesEscaneo.operarioId))
    .leftJoin(barcosCache, eq(barcosCache.odooId, sesionesEscaneo.barcoOdooId))
    .where(esProblema(alcance, ahora))
  if (sesiones.length === 0) return []

  const paquetes = await paquetesDeLasSesiones(sesiones.map((sesion) => sesion.id))

  return sesiones.map((sesion): Problema => {
    const tipo = tipoDeProblema(sesion.estado)
    const suyos = paquetes.get(sesion.id) ?? []
    return {
      sesionId: sesion.id,
      tipo,
      sesionTipo: sesion.tipo,
      almacenPrefijo: sesion.almacenPrefijo,
      barcoNombre: sesion.barcoNombre ?? `Barco #${sesion.barcoOdooId}`,
      operarioNombre: sesion.operarioNombre,
      // Every sesión that gets here was confirmed; `createdAt` only keeps the type honest.
      fecha: sesion.confirmedAt ?? sesion.createdAt,
      paquetes: (tipo === 'duplicado' ? suyos.filter((paquete) => paquete.dejadoAfueraAlEnviar) : suyos)
        .map(({ trackingNumber, ref }) => ({ trackingNumber, ref })),
      entrega: sesion.tipo === 'entrega'
        ? { paquetes: sesion.odooMoveLineIds?.length ?? 0, receptorNombre: sesion.receptorNombre }
        : null,
      mensaje: mensajeDe(tipo, sesion.ultimoErrorTipo),
      detalle: sesion.ultimoError,
      loArreglaElAdmin: sesion.ultimoErrorTipo === 'configuracion',
    }
  }).sort(porUrgencia)
}

/** How many problems `listarProblemas` lists for the same scope and moment: the number on the Pendientes tab. */
export async function contarProblemas(alcance: Alcance, ahora: Date = new Date()): Promise<number> {
  const [fila] = await db.select({ cantidad: count() }).from(sesionesEscaneo).where(esProblema(alcance, ahora))
  return fila.cantidad
}

/**
 * What the operario may see in Pendientes: everything for the admin; for anyone else, the problems of the
 * almacenes they have that are still active, which are the ones they can work in.
 */
export async function alcanceDelOperario(operario: Pick<Operario, 'id' | 'rol'>): Promise<Alcance> {
  if (operario.rol === 'admin') return 'todos'
  const suyos = await getAlmacenesForOperario(operario.id)
  return { almacenIds: suyos.map((almacen) => almacen.id) }
}

/** The estados from which the worker can be asked to try again. */
const ESTADOS_REINTENTABLES: SesionEscaneo['estado'][] = ['error', 'confirmada_pendiente_sync']

/**
 * Puts a sesión that failed (`error`) or is stuck (`confirmada_pendiente_sync`) back in the queue. For any
 * other it does nothing at all (no publishing, no audit): a screen that is out of date, showing a problem
 * somebody else already retried and that has synced since, must not queue it twice or undo that sync. The
 * estado is checked by the update that changes it, so there is no moment between the check and the change.
 *
 * It becomes `confirmada_pendiente_sync` BEFORE it is published: the workers only act on a sesión in that estado
 * and return, doing nothing, for the rest. `confirmedAt` starts over, since a send is stuck once it has waited
 * MINUTOS_TRABADO from the last time it was queued; otherwise a sesión that was sent days ago would be listed as
 * stuck the moment after its retry. The review is cleared too: a retry that fails again is a new problem.
 *
 * If publishing fails the error is passed on and the sesión is left as it is, waiting for a message that never
 * came, which is what Pendientes shows as stuck once it has waited long enough. The audit comes after publishing.
 */
export async function reintentar(entrada: { sesionId: string; operarioId: string }): Promise<void> {
  const { sesionId, operarioId } = entrada

  const [sesion] = await db.update(sesionesEscaneo)
    .set({ estado: 'confirmada_pendiente_sync', confirmedAt: new Date(), revisadoAt: null, revisadoPor: null })
    .where(and(eq(sesionesEscaneo.id, sesionId), inArray(sesionesEscaneo.estado, ESTADOS_REINTENTABLES)))
    .returning({ almacenId: sesionesEscaneo.almacenId, barcoOdooId: sesionesEscaneo.barcoOdooId })
  if (!sesion) return

  await publishSync({ sesionId })

  await registrarAuditoria({
    operarioId,
    accion: 'reintento',
    detalle: { sesionId, almacenId: sesion.almacenId, barcoOdooId: sesion.barcoOdooId },
  })
}

/**
 * Notes that somebody looked at a problem, so that it stops being listed. A duplicado can be reviewed by anybody;
 * a failed send (`error`) only by the admin, who marks it as resolved when retrying will never fix it (see
 * `esErrorSinResolver`). For anything else (a stuck send, an open recepción, a synced one with nothing left out)
 * it does nothing at all, no change and no audit, and so it does for an operario's attempt on a failed send.
 * That is checked by the update itself, with the conditions the list uses, so a screen that is out of date
 * (showing as a problem a send somebody has retried since) cannot stamp a send that is still on its way.
 *
 * `esAdmin` is whether the one calling is the admin. The domain trusts it: the server action takes it from the
 * session, never from the client.
 *
 * It changes nothing else: a failed send stays in `error`. The first review is the one that stays (who and
 * when), so an old screen that reviews it a second time changes and audits nothing. A retry clears it, and so
 * does a new final failure (`registrarFalloSync`): the problem is listed again.
 */
export async function marcarRevisado(entrada: { sesionId: string; operarioId: string; esAdmin?: boolean }): Promise<void> {
  const { sesionId, operarioId, esAdmin = false } = entrada

  const [sesion] = await db.update(sesionesEscaneo)
    .set({ revisadoAt: new Date(), revisadoPor: operarioId })
    .where(and(
      eq(sesionesEscaneo.id, sesionId),
      esAdmin ? or(esDuplicadoSinRevisar(), esErrorSinResolver()) : esDuplicadoSinRevisar(),
    ))
    .returning({
      almacenId: sesionesEscaneo.almacenId, barcoOdooId: sesionesEscaneo.barcoOdooId, estado: sesionesEscaneo.estado,
    })
  if (!sesion) return

  await registrarAuditoria({
    operarioId,
    accion: 'revisado',
    detalle: { sesionId, almacenId: sesion.almacenId, barcoOdooId: sesion.barcoOdooId, tipo: tipoDeProblema(sesion.estado) },
  })
}
