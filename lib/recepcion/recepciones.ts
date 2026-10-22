import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import {
  barcosCache, couriers, sesionCourierBatches, sesionItems, sesionesEscaneo,
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

/**
 * The batch of `courierId` in the recepción, created by the first package of that courier. One
 * statement, so two scans of a new courier at once get the same batch. `DO UPDATE` with a SET that
 * changes nothing, instead of `DO NOTHING`, because only that makes RETURNING answer the existing row.
 */
async function obtenerTanda(sesionId: string, courierId: number): Promise<string> {
  const [tanda] = await db.insert(sesionCourierBatches)
    .values({ sesionId, courierId })
    .onConflictDoUpdate({
      target: [sesionCourierBatches.sesionId, sesionCourierBatches.courierId],
      set: { sesionId },
    })
    .returning({ id: sesionCourierBatches.id })
  return tanda.id
}

/**
 * Adds a scanned code to the recepción under `courierId`. In this order: an empty code is
 * rejected; so is a recepción that is not `en_curso`; a code already in this recepción, or in
 * another one on its way to Odoo, is reported as `repetido` and nothing is written; a code Odoo
 * already has goes in as `duplicado` (kept, flagged, never sent); anything else goes in as `ok`.
 * The code is trimmed and not changed in any other way.
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

  const sesion = await buscarRecepcion(sesionId)
  if (sesion?.estado !== 'en_curso') throw recepcionNoAbierta(sesion)

  const donde = await dondeEstaElCodigo(sesionId, codigo)
  if (donde) return { tipo: 'repetido', trackingNumber: codigo, donde }

  const duplicado = await buscarDuplicado(codigo)
  const estado = duplicado ? 'duplicado' : 'ok'
  const duplicadoRef = duplicado?.odooPickingRef ?? null

  const tandaId = await obtenerTanda(sesionId, courierId)
  const [insertado] = await db.insert(sesionItems)
    .values({ courierBatchId: tandaId, trackingNumber: codigo, estado, duplicadoRef, operarioId })
    .onConflictDoNothing()
    .returning({ id: sesionItems.id })
  // The same code reached this recepción between the check above and the insert.
  if (!insertado) return { tipo: 'repetido', trackingNumber: codigo, donde: 'esta recepción' }

  // The recepción may have been sent while this scan was being checked, and the worker reads the packages
  // some time after the send: one that got in late may or may not be read. So look again, now that the
  // package is in. If the recepción is still open, any send comes after the insert and the worker will
  // read it; if not, take the package back out and refuse it, instead of showing as added one that may
  // never reach Odoo.
  const [courier, actual] = await Promise.all([
    db.select({ nombre: couriers.nombre }).from(couriers).where(eq(couriers.id, courierId)).then((filas) => filas[0]),
    buscarRecepcion(sesionId),
  ])
  if (actual?.estado !== 'en_curso') {
    await db.delete(sesionItems).where(eq(sesionItems.id, insertado.id))
    throw recepcionNoAbierta(actual)
  }

  return {
    tipo: 'agregado',
    paquete: { id: insertado.id, trackingNumber: codigo, courierId, courierNombre: courier.nombre, estado, duplicadoRef },
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
 */
export async function descartarRecepcion(entrada: { sesionId: string; operarioId: string }): Promise<void> {
  const { sesionId, operarioId } = entrada
  const sesion = await buscarRecepcion(sesionId)
  if (!sesion) return
  if (sesion.estado !== 'en_curso') throw new RecepcionCerradaError()

  const { validos, duplicados } = await contarPaquetes(sesionId)

  // A batch, so that on neon-http (no transactions) it is one transaction and never half done. Every
  // statement reaches the recepción only while it is `en_curso`: if it was sent after the check above,
  // none of them touches it, and the last one, which says what it deleted, is how that is noticed.
  const [, , borradas] = await db.batch([
    db.delete(sesionItems).where(inArray(sesionItems.courierBatchId, tandasAbiertas(sesionId))),
    db.delete(sesionCourierBatches).where(inArray(sesionCourierBatches.id, tandasAbiertas(sesionId))),
    db.delete(sesionesEscaneo)
      .where(and(eq(sesionesEscaneo.id, sesionId), eq(sesionesEscaneo.estado, 'en_curso')))
      .returning({ id: sesionesEscaneo.id }),
  ])
  if (borradas.length === 0) throw new RecepcionCerradaError()

  await registrarAuditoria({
    operarioId,
    accion: 'recepcion_descartada',
    detalle: { sesionId, almacenId: sesion.almacenId, barcoOdooId: sesion.barcoOdooId, paquetes: validos + duplicados },
  })
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
 * (`vacia_descartada`); one with only duplicados stays open (`sin_paquetes_validos`), since
 * there is nothing to send and somebody has to look at what Odoo already has. Otherwise it is marked
 * `confirmada_pendiente_sync` first, so that the worker finds it so the moment it is queued, and
 * then published. If publishing fails it goes back to `en_curso` and the error is passed on.
 */
export async function enviarRecepcion(entrada: { sesionId: string; operarioId: string }): Promise<ResultadoEnvio> {
  const { sesionId, operarioId } = entrada
  const sesion = await buscarRecepcion(sesionId)
  if (sesion?.estado !== 'en_curso') throw recepcionNoAbierta(sesion)

  const { validos, duplicados } = await contarPaquetes(sesionId)
  if (validos + duplicados === 0) {
    await descartarRecepcion({ sesionId, operarioId })
    return 'vacia_descartada'
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
 * `barcoOdooId` is given), oldest first, and says how many it sent. The empty ones and those with
 * only duplicados are left alone: an operario may be about to scan into them. A recepción that
 * somebody else sent or discarded meanwhile is skipped; any other failure (the publishing) stops
 * it there, with what was sent staying sent and the rest still open.
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
      if (await enviarRecepcion({ sesionId: id, operarioId: entrada.operarioId }) === 'enviada') enviadas += 1
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
      barcoOdooId: sesionesEscaneo.barcoOdooId,
      barcoNombre: barcosCache.nombre,
      estado: sesionesEscaneo.estado,
    })
      .from(sesionesEscaneo)
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
