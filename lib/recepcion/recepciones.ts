import { and, asc, count, desc, eq, gte, inArray, notExists, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db/client'
import {
  almacenes, barcosCache, couriers, sesionCourierBatches, sesionItems, sesionesEscaneo,
  type SesionEscaneo,
} from '../../db/schema'
import { registrarAuditoria } from '../audit'
import { buscarDuplicado } from '../cache/trackingActivos'
import { ErrorParaOperario } from '../errores'
import { inicioDeHoy } from '../fechas'
import { publishSync } from '../queue/publish'

/**
 * The recepciones are shared: one belongs to an almacén and a barco, not to the operario who
 * opened it, and stays `en_curso` while packages pile up until somebody sends it. These
 * functions trust their parameters. Who may touch which almacén is decided by the server
 * actions that call them.
 */

/** The recepción already left the operarios' hands: it can neither take packages nor lose them. */
export class RecepcionCerradaError extends ErrorParaOperario {
  constructor(mensaje = 'Esta recepción ya se envió a Odoo.') {
    super(mensaje)
  }
}

/** The scan cannot be taken: there is no code, or there is no recepción to put it in. */
export class EscaneoInvalidoError extends ErrorParaOperario {}

export interface PaqueteEscaneado {
  id: string
  trackingNumber: string
  courierId: number
  courierNombre: string
  /** `duplicado`: Odoo already has it. It is kept, flagged, so it can be seen and taken out, and it is not sent. */
  estado: 'ok' | 'duplicado'
  /** Where Odoo has it, for a `duplicado`. */
  duplicadoRef: string | null
}

export type ResultadoEscaneo =
  | { tipo: 'agregado'; paquete: PaqueteEscaneado }
  | { tipo: 'repetido'; trackingNumber: string; donde: string }

/** Recepciones whose packages are not in Odoo yet, and so are the only ones a scan can repeat. */
const ESTADOS_EN_CAMINO: SesionEscaneo['estado'][] = ['en_curso', 'confirmada_pendiente_sync']

/** A recepción, nothing else: `tipo` keeps an entrega from being taken for one. */
function buscarRecepcion(sesionId: string) {
  return db.query.sesionesEscaneo.findFirst({
    columns: { id: true, almacenId: true, barcoOdooId: true, estado: true },
    where: and(eq(sesionesEscaneo.id, sesionId), eq(sesionesEscaneo.tipo, 'recepcion')),
  })
}

/**
 * A recepción that is still `en_curso`, as a condition: what the statements that may only touch an open recepción ask,
 * the write of a scan (`guardarPaquete`) and the lock of the discards (`bloquearAbierta`) among them. One definition,
 * so that the lock and what it protects always cover the same row.
 */
function recepcionAbierta(sesionId: string): SQL {
  return sql`(${eq(sesionesEscaneo.id, sesionId)} and ${eq(sesionesEscaneo.tipo, 'recepcion')} and ${eq(sesionesEscaneo.estado, 'en_curso')})`
}

/** Why a recepción cannot be changed: there is none, or it is not `en_curso` any more. */
function recepcionNoAbierta(sesion: { estado: SesionEscaneo['estado'] } | undefined): ErrorParaOperario {
  return sesion ? new RecepcionCerradaError() : new EscaneoInvalidoError('La recepción no existe.')
}

const nombreDeBarco = (nombre: string | null, barcoOdooId: number) => nombre ?? `Barco #${barcoOdooId}`

/**
 * The open recepción of the almacén and barco, which is opened if there is none. Everyone who
 * asks gets the same one, so a second operario (or a double tap) joins it and never makes a twin.
 */
export async function abrirRecepcion(entrada: { almacenId: number; barcoOdooId: number; operarioId: string }): Promise<string> {
  const { almacenId, barcoOdooId, operarioId } = entrada

  // The partial unique index (one `en_curso` recepción per almacén and barco) is what decides who
  // creates it: whoever loses the race inserts nothing and finds the winner's.
  const [creada] = await db.insert(sesionesEscaneo)
    .values({ operarioId, almacenId, barcoOdooId, tipo: 'recepcion' })
    .onConflictDoNothing()
    .returning({ id: sesionesEscaneo.id })
  if (creada) return creada.id

  const abierta = await db.query.sesionesEscaneo.findFirst({
    columns: { id: true },
    where: and(
      eq(sesionesEscaneo.almacenId, almacenId),
      eq(sesionesEscaneo.barcoOdooId, barcoOdooId),
      eq(sesionesEscaneo.tipo, 'recepcion'),
      eq(sesionesEscaneo.estado, 'en_curso'),
    ),
  })
  // Only if that recepción was sent in the few milliseconds since the insert; trying again opens a new one.
  if (!abierta) throw new Error(`The open recepción of almacén ${almacenId} and barco ${barcoOdooId} was sent while it was being opened`)
  return abierta.id
}

/**
 * Where the recepciones that are not in Odoo yet already have `codigo`: `'esta recepción'`
 * (`sesionId`, which is `en_curso`), or `'la recepción de <barco>'` for another one, of any
 * almacén: the same package cannot be in two places. Null when none has it.
 */
async function dondeEstaElCodigo(sesionId: string, codigo: string): Promise<string | null> {
  const filas = await db.select({
    sesionId: sesionesEscaneo.id,
    barcoOdooId: sesionesEscaneo.barcoOdooId,
    barcoNombre: barcosCache.nombre,
  })
    .from(sesionItems)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.id, sesionItems.courierBatchId))
    .innerJoin(sesionesEscaneo, eq(sesionesEscaneo.id, sesionCourierBatches.sesionId))
    .leftJoin(barcosCache, eq(barcosCache.odooId, sesionesEscaneo.barcoOdooId))
    .where(and(
      eq(sesionItems.trackingNumber, codigo),
      eq(sesionesEscaneo.tipo, 'recepcion'),
      inArray(sesionesEscaneo.estado, ESTADOS_EN_CAMINO),
    ))
    .orderBy(asc(sesionesEscaneo.createdAt), asc(sesionesEscaneo.id))

  if (filas.length === 0) return null
  if (filas.some((fila) => fila.sesionId === sesionId)) return 'esta recepción'
  const otra = filas[0]
  return `la recepción de ${nombreDeBarco(otra.barcoNombre, otra.barcoOdooId)}`
}

/** The name of the courier, for the answer to a scan. Undefined when no courier has the id. */
async function nombreDelCourier(courierId: number): Promise<string | undefined> {
  const [courier] = await db.select({ nombre: couriers.nombre }).from(couriers).where(eq(couriers.id, courierId))
  return courier?.nombre
}

/** A package about to go into a recepción, as `escanearPaquete` decided it. */
interface PaqueteNuevo {
  sesionId: string
  courierId: number
  trackingNumber: string
  estado: PaqueteEscaneado['estado']
  duplicadoRef: string | null
  operarioId: string
}

/**
 * What writing a package found: whether the recepción was still `en_curso`, and the id of the package when it went in
 * (null when the code was already in its courier batch, or when the recepción was not open).
 */
interface PaqueteGuardado {
  abierta: boolean
  paqueteId: string | null
}

/**
 * Puts the package in the recepción, in the batch of its courier (made by the first package of that courier), in one
 * statement, and only while the recepción is `en_curso`.
 *
 * The recepción is held `FOR SHARE` until the package is in. A send ("Enviar") is an UPDATE of that row, so one that
 * arrives meanwhile waits for this to commit, and the worker, which reads the packages after the send, finds the
 * package; one that got there first leaves the recepción out of `abierta`, and nothing is written. The discards lock
 * the row first thing too (`bloquearAbierta`), so a discard and a scan wait for each other instead of crossing.
 *
 * The batch is an upsert with `DO UPDATE` and a SET that changes nothing, instead of `DO NOTHING`, because only that
 * makes RETURNING answer the existing row: two scans of a new courier at once get the same batch. The parameters say
 * their types because an `INSERT ... SELECT` does not take them from the columns.
 */
async function guardarPaquete(paquete: PaqueteNuevo): Promise<PaqueteGuardado> {
  const { rows } = await db.execute<{ abierta: boolean; paquete_id: string | null }>(sql`
    with abierta as (
      select ${sesionesEscaneo.id} as id from ${sesionesEscaneo}
      where ${recepcionAbierta(paquete.sesionId)}
      for share
    ), tanda as (
      insert into ${sesionCourierBatches} (sesion_id, courier_id)
      select id, ${paquete.courierId}::integer from abierta
      on conflict (sesion_id, courier_id) do update set sesion_id = excluded.sesion_id
      returning id
    ), nuevo as (
      insert into ${sesionItems} (courier_batch_id, tracking_number, estado, duplicado_ref, operario_id)
      select id, ${paquete.trackingNumber}::text, ${paquete.estado}::estado_item, ${paquete.duplicadoRef}::text, ${paquete.operarioId}::uuid
      from tanda
      on conflict (courier_batch_id, tracking_number) do nothing
      returning id
    )
    select exists (select 1 from abierta) as abierta, (select id from nuevo) as paquete_id
  `)
  return { abierta: rows[0].abierta, paqueteId: rows[0].paquete_id }
}

/**
 * Adds a scanned code to the recepción under `courierId`. In this order: an empty code is
 * rejected; so is a recepción that is not `en_curso`; a code already in this recepción, or in
 * another one on its way to Odoo, is reported as `repetido` and nothing is written; a code Odoo
 * already has goes in as `duplicado` (kept, flagged, never sent); anything else goes in as `ok`.
 * The code is trimmed and not changed in any other way.
 *
 * Next runs the actions of a client one after the other, so every scan of a burst of the gun waits for the one
 * before it, and each round trip to the database is paid once per code. So what the scan has to know is read at once
 * (none of it depends on the rest), and the package is written in one statement that checks the recepción again
 * (`guardarPaquete`).
 */
export async function escanearPaquete(entrada: {
  sesionId: string
  courierId: number
  trackingNumber: string
  operarioId: string
}): Promise<ResultadoEscaneo> {
  const { sesionId, courierId, operarioId } = entrada
  const codigo = entrada.trackingNumber.trim()
  if (codigo === '') throw new EscaneoInvalidoError('El código está vacío.')

  const [sesion, donde, duplicado, courierNombre] = await Promise.all([
    buscarRecepcion(sesionId),
    dondeEstaElCodigo(sesionId, codigo),
    buscarDuplicado(codigo),
    nombreDelCourier(courierId),
  ])
  if (sesion?.estado !== 'en_curso') throw recepcionNoAbierta(sesion)
  if (donde) return { tipo: 'repetido', trackingNumber: codigo, donde }
  // An id that names no courier: nothing is written, and the operario gets the generic message.
  if (courierNombre === undefined) throw new Error(`No courier has the id ${courierId}`)

  const estado = duplicado ? 'duplicado' : 'ok'
  const duplicadoRef = duplicado?.odooPickingRef ?? null
  const guardado = await guardarPaquete({ sesionId, courierId, trackingNumber: codigo, estado, duplicadoRef, operarioId })
  // The recepción was sent or discarded while this scan was being checked, and the package did not go in. It is read
  // once more to say which.
  if (!guardado.abierta) throw recepcionNoAbierta(await buscarRecepcion(sesionId))
  // The same code reached this recepción between the check above and the insert.
  if (guardado.paqueteId === null) return { tipo: 'repetido', trackingNumber: codigo, donde: 'esta recepción' }

  return {
    tipo: 'agregado',
    paquete: { id: guardado.paqueteId, trackingNumber: codigo, courierId, courierNombre, estado, duplicadoRef },
  }
}

/**
 * The courier batches of the recepciones that are still `en_curso` (of just one, if `sesionId` is
 * given). Used as the `IN (...)` of a DELETE so that the statement itself checks the state: it cannot
 * reach a recepción that was sent a moment before, which a check made earlier could not promise.
 */
function tandasAbiertas(sesionId?: string) {
  return db.select({ id: sesionCourierBatches.id })
    .from(sesionCourierBatches)
    .innerJoin(sesionesEscaneo, eq(sesionesEscaneo.id, sesionCourierBatches.sesionId))
    .where(and(
      eq(sesionesEscaneo.estado, 'en_curso'),
      sesionId === undefined ? undefined : eq(sesionesEscaneo.id, sesionId),
    ))
}

/**
 * The first statement of a discard's batch: the recepción, locked FOR UPDATE while it is `en_curso`. A scan holds the
 * same row FOR SHARE while it writes (`guardarPaquete`), so the two take that row first and one waits for the other,
 * instead of each holding something the other needs.
 */
function bloquearAbierta(sesionId: string) {
  return db.select({ id: sesionesEscaneo.id }).from(sesionesEscaneo).where(recepcionAbierta(sesionId)).for('update')
}

/** How many packages the recepción has: the `ok` ones, which are sent, and the `duplicado` ones, which are not. */
async function contarPaquetes(sesionId: string): Promise<{ validos: number; duplicados: number }> {
  const filas = await db.select({ estado: sesionItems.estado, cantidad: count() })
    .from(sesionItems)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.id, sesionItems.courierBatchId))
    .where(eq(sesionCourierBatches.sesionId, sesionId))
    .groupBy(sesionItems.estado)
  const deEstado = (estado: 'ok' | 'duplicado') => filas.find((fila) => fila.estado === estado)?.cantidad ?? 0
  return { validos: deEstado('ok'), duplicados: deEstado('duplicado') }
}

/**
 * Takes a scanned package out of its recepción, whichever courier it was under. Only while the
 * recepción is `en_curso`: once sent, it is what the worker is reading. A package that is already
 * gone is not an error, since it is gone either way (the other tablet took it out first).
 */
export async function borrarPaquete(itemId: string): Promise<void> {
  const borrados = await db.delete(sesionItems)
    .where(and(eq(sesionItems.id, itemId), inArray(sesionItems.courierBatchId, tandasAbiertas())))
    .returning({ id: sesionItems.id })
  if (borrados.length > 0) return

  const existe = await db.query.sesionItems.findFirst({ columns: { id: true }, where: eq(sesionItems.id, itemId) })
  if (existe) throw new RecepcionCerradaError()
}

/**
 * Throws away an open recepción with everything in it: packages, courier batches and the recepción
 * itself. A recepción that is already gone is not an error. One that was sent is: it is the worker's now.
 * This is the discard an operario asked for and confirmed, knowing what is in it. To clean up one that
 * only looks empty use `descartarSiVacia`, which cannot throw away a package that landed meanwhile.
 */
export async function descartarRecepcion(entrada: { sesionId: string; operarioId: string }): Promise<void> {
  const { sesionId, operarioId } = entrada
  const [sesion, { validos, duplicados }] = await Promise.all([buscarRecepcion(sesionId), contarPaquetes(sesionId)])
  if (!sesion) return
  if (sesion.estado !== 'en_curso') throw new RecepcionCerradaError()

  // A batch, so that on neon-http (no transactions) it is one transaction and never half done. It locks the
  // recepción first (`bloquearAbierta`): a scan that is writing finishes before the deletes look, and one that
  // comes later finds the recepción gone. Every statement reaches the recepción only while it is `en_curso`: if it
  // was sent after the check above, none of them touches it, and the last one, which says what it deleted, is how
  // that is noticed.
  const [, , , borradas] = await db.batch([
    bloquearAbierta(sesionId),
    db.delete(sesionItems).where(inArray(sesionItems.courierBatchId, tandasAbiertas(sesionId))),
    db.delete(sesionCourierBatches).where(inArray(sesionCourierBatches.id, tandasAbiertas(sesionId))),
    db.delete(sesionesEscaneo).where(recepcionAbierta(sesionId)).returning({ id: sesionesEscaneo.id }),
  ])
  if (borradas.length === 0) throw new RecepcionCerradaError()

  await registrarAuditoria({
    operarioId,
    accion: 'recepcion_descartada',
    detalle: { sesionId, almacenId: sesion.almacenId, barcoOdooId: sesion.barcoOdooId, paquetes: validos + duplicados },
  })
}

/**
 * Discards the recepción only if it has no package at all, and says whether it did. It is the
 * cleanup for one that merely looks empty (an operario leaves it, "Enviar" finds nothing in it),
 * which can be a screen that is out of date: a package scanned meanwhile must not go with it, as it
 * would with `descartarRecepcion`, which deletes whatever is inside. So emptiness is decided by the
 * statements that delete, in one `db.batch`: first the recepción is locked (`bloquearAbierta`), then
 * the courier batches with no package go, then the recepción goes if none of its batches is left; all
 * only while it is a `recepcion` in `en_curso`. A scan that is writing finishes before the deletes look,
 * and keeps the recepción; one that comes later finds it gone and says so: nothing is lost without
 * somebody knowing. False: it has a package, or it was sent, or it is gone.
 */
export async function descartarSiVacia(entrada: { sesionId: string; operarioId: string }): Promise<boolean> {
  const { sesionId, operarioId } = entrada
  const abierta = recepcionAbierta(sesionId)

  const [, , borradas] = await db.batch([
    bloquearAbierta(sesionId),
    db.delete(sesionCourierBatches).where(and(
      inArray(sesionCourierBatches.sesionId, db.select({ id: sesionesEscaneo.id }).from(sesionesEscaneo).where(abierta)),
      notExists(db.select({ uno: sql`1` }).from(sesionItems).where(eq(sesionItems.courierBatchId, sesionCourierBatches.id))),
    )),
    db.delete(sesionesEscaneo)
      .where(and(
        abierta,
        notExists(db.select({ uno: sql`1` }).from(sesionCourierBatches).where(eq(sesionCourierBatches.sesionId, sesionesEscaneo.id))),
      ))
      .returning({ almacenId: sesionesEscaneo.almacenId, barcoOdooId: sesionesEscaneo.barcoOdooId }),
  ])
  const borrada = borradas[0]
  if (!borrada) return false

  await registrarAuditoria({
    operarioId,
    accion: 'recepcion_descartada',
    detalle: { sesionId, almacenId: borrada.almacenId, barcoOdooId: borrada.barcoOdooId, paquetes: 0 },
  })
  return true
}

export type ResultadoEnvio = 'enviada' | 'sin_paquetes_validos' | 'vacia_descartada'

/**
 * Puts a recepción whose publishing failed back in the operarios' hands, unless the worker already
 * took it. If another operario opened the barco again while it waited (the unique index allows one
 * `en_curso` recepción per almacén and barco, and this one had left that set), the update is
 * refused. The recepción then stays `confirmada_pendiente_sync`, which is the "Envío trabado" case of
 * Pendientes (spec §5.4), where it can be retried; the caller still gets the error that matters,
 * the one from publishing.
 */
async function reabrirTrasFallo(sesionId: string): Promise<void> {
  try {
    await db.update(sesionesEscaneo)
      .set({ estado: 'en_curso', confirmedAt: null })
      .where(and(eq(sesionesEscaneo.id, sesionId), eq(sesionesEscaneo.estado, 'confirmada_pendiente_sync')))
  } catch (err) {
    console.error('could not reopen a recepción after publishing it failed', { sesionId, err })
  }
}

/**
 * Sends the recepción to Odoo, that is, hands it to the queue. An empty one is discarded instead
 * (`vacia_descartada`), but only if it is still empty when it comes to deleting it: a package that
 * landed since it was counted is sent like any other. One with only duplicados stays open
 * (`sin_paquetes_validos`), since there is nothing to send and somebody has to look at what Odoo
 * already has. Otherwise it is marked `confirmada_pendiente_sync` first, so that the worker finds it
 * so the moment it is queued, and then published. If publishing fails it goes back to `en_curso`
 * and the error is passed on.
 */
export async function enviarRecepcion(entrada: { sesionId: string; operarioId: string }): Promise<ResultadoEnvio> {
  return enviar(entrada, { descartarSiEstaVacia: true })
}

/**
 * `enviarRecepcion`, with the choice of what to do with a recepción that has no package at all:
 * discard it (what "Enviar" does) or leave it as it is and answer `sin_paquetes_validos` (what "Enviar
 * todas" does: an operario may be about to scan into it). If the discard finds it is not empty any
 * more (or that somebody sent or discarded it), it looks at the recepción again once, as an ordinary send.
 */
async function enviar(
  entrada: { sesionId: string; operarioId: string },
  opciones: { descartarSiEstaVacia: boolean },
): Promise<ResultadoEnvio> {
  const { sesionId, operarioId } = entrada
  const [sesion, { validos, duplicados }] = await Promise.all([buscarRecepcion(sesionId), contarPaquetes(sesionId)])
  if (sesion?.estado !== 'en_curso') throw recepcionNoAbierta(sesion)

  if (validos + duplicados === 0 && opciones.descartarSiEstaVacia) {
    if (await descartarSiVacia(entrada)) return 'vacia_descartada'
    return enviar(entrada, { descartarSiEstaVacia: false })
  }
  if (validos === 0) return 'sin_paquetes_validos'

  // A conditional update, not a plain one: of two operarios who press "Enviar" together, only one
  // finds it `en_curso`, and only that one publishes.
  const [confirmada] = await db.update(sesionesEscaneo)
    .set({ estado: 'confirmada_pendiente_sync', confirmedAt: new Date() })
    .where(and(eq(sesionesEscaneo.id, sesionId), eq(sesionesEscaneo.estado, 'en_curso')))
    .returning({ id: sesionesEscaneo.id })
  if (!confirmada) throw new RecepcionCerradaError()

  try {
    await publishSync({ sesionId })
  } catch (error) {
    await reabrirTrasFallo(sesionId)
    throw error
  }

  await registrarAuditoria({
    operarioId,
    accion: 'recepcion_enviada',
    detalle: { sesionId, almacenId: sesion.almacenId, barcoOdooId: sesion.barcoOdooId, paquetes: validos, duplicados },
  })
  return 'enviada'
}

/**
 * Sends every open recepción of the almacén that has at least one valid package (of one barco, if
 * `barcoOdooId` is given), oldest first, and says how many it sent. It never discards anything: the
 * empty ones and those with only duplicados are left as they are, an operario may be about to scan
 * into them, and so is one that became so after the list was read. A recepción that somebody else
 * sent or discarded meanwhile is skipped; any other failure (the publishing) stops it there, with
 * what was sent staying sent and the rest still open.
 */
export async function enviarRecepcionesAbiertas(entrada: {
  almacenId: number
  operarioId: string
  barcoOdooId?: number
}): Promise<number> {
  const candidatas = await db.selectDistinct({ id: sesionesEscaneo.id, createdAt: sesionesEscaneo.createdAt })
    .from(sesionesEscaneo)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.sesionId, sesionesEscaneo.id))
    .innerJoin(sesionItems, eq(sesionItems.courierBatchId, sesionCourierBatches.id))
    .where(and(
      eq(sesionesEscaneo.almacenId, entrada.almacenId),
      eq(sesionesEscaneo.tipo, 'recepcion'),
      eq(sesionesEscaneo.estado, 'en_curso'),
      eq(sesionItems.estado, 'ok'),
      entrada.barcoOdooId === undefined ? undefined : eq(sesionesEscaneo.barcoOdooId, entrada.barcoOdooId),
    ))
    .orderBy(asc(sesionesEscaneo.createdAt), asc(sesionesEscaneo.id))

  let enviadas = 0
  for (const { id } of candidatas) {
    try {
      const resultado = await enviar({ sesionId: id, operarioId: entrada.operarioId }, { descartarSiEstaVacia: false })
      if (resultado === 'enviada') enviadas += 1
    } catch (error) {
      if (error instanceof RecepcionCerradaError || error instanceof EscaneoInvalidoError) continue
      throw error
    }
  }
  return enviadas
}

export interface RecepcionAbierta {
  id: string
  barcoOdooId: number
  barcoNombre: string
  /** The packages that will be sent: the valid ones, not the duplicados. */
  paquetes: number
  /** The duplicados: packages Odoo already has, which are in the recepción flagged and are not sent. */
  duplicados: number
  /** The couriers of the packages that will be sent, the ones with the most first. A courier with only duplicados is not in it. */
  porCourier: Array<{ nombre: string; cantidad: number }>
  abiertaDesde: Date
}

/**
 * The open recepciones of the almacén that have at least one package of any kind, oldest first: an
 * empty one is just an operario who opened a barco and has not scanned yet, but one with only
 * duplicados is listed (with `paquetes` 0), since somebody has to look at it. Whoever has the
 * almacén sees them all: they belong to the almacén and the barco, not to who opened them.
 */
export async function listarRecepcionesAbiertas(almacenId: number): Promise<RecepcionAbierta[]> {
  const filas = await db.select({
    id: sesionesEscaneo.id,
    barcoOdooId: sesionesEscaneo.barcoOdooId,
    barcoNombre: barcosCache.nombre,
    abiertaDesde: sesionesEscaneo.createdAt,
    courierNombre: couriers.nombre,
    validos: sql<number>`count(*) filter (where ${sesionItems.estado} = 'ok')`.mapWith(Number),
    duplicados: sql<number>`count(*) filter (where ${sesionItems.estado} = 'duplicado')`.mapWith(Number),
  })
    .from(sesionesEscaneo)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.sesionId, sesionesEscaneo.id))
    .innerJoin(sesionItems, eq(sesionItems.courierBatchId, sesionCourierBatches.id))
    .innerJoin(couriers, eq(couriers.id, sesionCourierBatches.courierId))
    .leftJoin(barcosCache, eq(barcosCache.odooId, sesionesEscaneo.barcoOdooId))
    .where(and(
      eq(sesionesEscaneo.almacenId, almacenId),
      eq(sesionesEscaneo.tipo, 'recepcion'),
      eq(sesionesEscaneo.estado, 'en_curso'),
    ))
    .groupBy(sesionesEscaneo.id, barcosCache.nombre, couriers.id, couriers.nombre)
    .orderBy(asc(sesionesEscaneo.createdAt), asc(sesionesEscaneo.id))

  // One row per recepción and courier, already in the order of the recepciones.
  const recepciones = new Map<string, RecepcionAbierta>()
  for (const fila of filas) {
    let recepcion = recepciones.get(fila.id)
    if (!recepcion) {
      recepcion = {
        id: fila.id,
        barcoOdooId: fila.barcoOdooId,
        barcoNombre: nombreDeBarco(fila.barcoNombre, fila.barcoOdooId),
        paquetes: 0,
        duplicados: 0,
        porCourier: [],
        abiertaDesde: fila.abiertaDesde,
      }
      recepciones.set(fila.id, recepcion)
    }
    recepcion.paquetes += fila.validos
    recepcion.duplicados += fila.duplicados
    if (fila.validos > 0) recepcion.porCourier.push({ nombre: fila.courierNombre, cantidad: fila.validos })
  }
  for (const recepcion of recepciones.values()) {
    recepcion.porCourier.sort((a, b) => b.cantidad - a.cantidad || a.nombre.localeCompare(b.nombre, 'es'))
  }
  return [...recepciones.values()]
}

export interface RecepcionEnviada {
  id: string
  barcoNombre: string
  /** The packages that went to Odoo: every one of the recepción except the duplicados. */
  paquetes: number
  /** `enviando`: waiting for the worker. `ok`: it is in Odoo. `problema`: it failed, or it went in with a note. */
  estado: 'enviando' | 'ok' | 'problema'
  /** The reference of the picking Odoo made, once there is one. */
  odooPickingRef: string | null
  enviadaAt: Date
}

const ESTADOS_ENVIADA: SesionEscaneo['estado'][] = ['confirmada_pendiente_sync', 'sincronizada', 'error']

function estadoDeEnvio(estado: SesionEscaneo['estado'], ultimoError: string | null): RecepcionEnviada['estado'] {
  if (estado === 'confirmada_pendiente_sync') return 'enviando'
  // A recepción can sync and still leave a note in `ultimoError` (everything in it was a duplicate).
  return estado === 'sincronizada' && !ultimoError ? 'ok' : 'problema'
}

/**
 * The recepciones of the almacén that were sent since 00:00 of the day `ahora` falls on in
 * Madrid, in the order they were sent, each with how its sync is going.
 */
export async function listarEnviadasHoy(almacenId: number, ahora: Date = new Date()): Promise<RecepcionEnviada[]> {
  const filas = await db.select({
    id: sesionesEscaneo.id,
    barcoOdooId: sesionesEscaneo.barcoOdooId,
    barcoNombre: barcosCache.nombre,
    estado: sesionesEscaneo.estado,
    ultimoError: sesionesEscaneo.ultimoError,
    odooPickingRef: sesionesEscaneo.odooPickingRef,
    confirmedAt: sesionesEscaneo.confirmedAt,
    // Whatever is not a duplicado went (or goes) to Odoo, in whatever state its sync has left it.
    paquetes: sql<number>`count(${sesionItems.id}) filter (where ${sesionItems.estado} <> 'duplicado')`.mapWith(Number),
  })
    .from(sesionesEscaneo)
    .leftJoin(sesionCourierBatches, eq(sesionCourierBatches.sesionId, sesionesEscaneo.id))
    .leftJoin(sesionItems, eq(sesionItems.courierBatchId, sesionCourierBatches.id))
    .leftJoin(barcosCache, eq(barcosCache.odooId, sesionesEscaneo.barcoOdooId))
    .where(and(
      eq(sesionesEscaneo.almacenId, almacenId),
      eq(sesionesEscaneo.tipo, 'recepcion'),
      inArray(sesionesEscaneo.estado, ESTADOS_ENVIADA),
      gte(sesionesEscaneo.confirmedAt, inicioDeHoy(ahora)),
    ))
    .groupBy(sesionesEscaneo.id, barcosCache.nombre)
    .orderBy(asc(sesionesEscaneo.confirmedAt), asc(sesionesEscaneo.id))

  return filas.map((fila) => ({
    id: fila.id,
    barcoNombre: nombreDeBarco(fila.barcoNombre, fila.barcoOdooId),
    paquetes: fila.paquetes,
    estado: estadoDeEnvio(fila.estado, fila.ultimoError),
    odooPickingRef: fila.odooPickingRef,
    enviadaAt: fila.confirmedAt as Date, // the WHERE only lets through the ones that have it
  }))
}

export interface RecepcionDetalle {
  id: string
  almacenId: number
  /** The prefix of that almacén ("MB92"), which is how the operarios call it. */
  almacenPrefijo: string
  barcoOdooId: number
  barcoNombre: string
  estado: SesionEscaneo['estado']
  /** The newest first. */
  paquetes: PaqueteEscaneado[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A recepción with its packages, the newest first, whatever its estado: the screen shows one that
 * was already sent as read-only. Null when there is none. The id comes from the address bar, so
 * something that is not even an id is "none" and not a database error.
 */
export async function getRecepcion(sesionId: string): Promise<RecepcionDetalle | null> {
  if (!UUID.test(sesionId)) return null

  const [sesiones, paquetes] = await Promise.all([
    db.select({
      id: sesionesEscaneo.id,
      almacenId: sesionesEscaneo.almacenId,
      almacenPrefijo: almacenes.prefijo,
      barcoOdooId: sesionesEscaneo.barcoOdooId,
      barcoNombre: barcosCache.nombre,
      estado: sesionesEscaneo.estado,
    })
      .from(sesionesEscaneo)
      .innerJoin(almacenes, eq(almacenes.id, sesionesEscaneo.almacenId))
      .leftJoin(barcosCache, eq(barcosCache.odooId, sesionesEscaneo.barcoOdooId))
      .where(and(eq(sesionesEscaneo.id, sesionId), eq(sesionesEscaneo.tipo, 'recepcion'))),
    db.select({
      id: sesionItems.id,
      trackingNumber: sesionItems.trackingNumber,
      courierId: sesionCourierBatches.courierId,
      courierNombre: couriers.nombre,
      estado: sesionItems.estado,
      duplicadoRef: sesionItems.duplicadoRef,
    })
      .from(sesionItems)
      .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.id, sesionItems.courierBatchId))
      .innerJoin(couriers, eq(couriers.id, sesionCourierBatches.courierId))
      .where(eq(sesionCourierBatches.sesionId, sesionId))
      // The id last, so that two packages with the same time never swap places between one call and the next.
      .orderBy(desc(sesionItems.createdAt), desc(sesionItems.id)),
  ])

  const sesion = sesiones[0]
  if (!sesion) return null
  return {
    id: sesion.id,
    almacenId: sesion.almacenId,
    almacenPrefijo: sesion.almacenPrefijo,
    barcoOdooId: sesion.barcoOdooId,
    barcoNombre: nombreDeBarco(sesion.barcoNombre, sesion.barcoOdooId),
    estado: sesion.estado,
    paquetes: paquetes.map((fila) => ({
      id: fila.id,
      trackingNumber: fila.trackingNumber,
      courierId: fila.courierId,
      courierNombre: fila.courierNombre,
      // A package is either flagged as already in Odoo or it counts, whether it went to Odoo yet or not.
      estado: fila.estado === 'duplicado' ? 'duplicado' : 'ok',
      duplicadoRef: fila.duplicadoRef,
    })),
  }
}

/**
 * How many valid packages the open recepciones of the almacén hold per barco (key: the barco's Odoo
 * id): what is received but not in Odoo yet. A barco with none is not in the map.
 */
export async function contarSinEnviarPorBarco(almacenId: number): Promise<Map<number, number>> {
  const filas = await db.select({ barcoOdooId: sesionesEscaneo.barcoOdooId, cantidad: count() })
    .from(sesionItems)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.id, sesionItems.courierBatchId))
    .innerJoin(sesionesEscaneo, eq(sesionesEscaneo.id, sesionCourierBatches.sesionId))
    .where(and(
      eq(sesionesEscaneo.almacenId, almacenId),
      eq(sesionesEscaneo.tipo, 'recepcion'),
      eq(sesionesEscaneo.estado, 'en_curso'),
      eq(sesionItems.estado, 'ok'),
    ))
    .groupBy(sesionesEscaneo.barcoOdooId)
  return new Map(filas.map((fila) => [fila.barcoOdooId, fila.cantidad]))
}
