import { and, asc, eq, gte, inArray, ne } from 'drizzle-orm'
import { db } from '../../db/client'
import { barcosCache, sesionesEscaneo, type Almacen, type PaqueteDeOdoo, type SesionEscaneo } from '../../db/schema'
import { registrarAuditoria, type AccionAuditoria } from '../audit'
import { etiquetasDeBarcos } from '../cache/barcos'
import { ConfiguracionError } from '../errores'
import { inicioDeHoy } from '../fechas'
import { getBarcosConEntregaPendiente } from '../odoo/pickings'
import { publishSync } from '../queue/publish'
import { contarSinEnviarPorBarco } from '../recepcion/recepciones'
import type { Retencion } from './lineas'

/**
 * What a barco is called: its name in the cache, or, for one the cache does not know (created in Odoo since the last
 * refresh, or archived), the placeholder that the lists and the recepciones use.
 */
export function nombreDelBarco(nombre: string | null | undefined, barcoOdooId: number): string {
  return nombre ?? `Barco #${barcoOdooId}`
}

/** A barco of the delivery list. */
export interface BarcoParaEntregar {
  barcoOdooId: number
  barcoNombre: string
  /**
   * What the list shows for the barco: its name, with the Odoo id after it when another barco of the list has the
   * same name (there can be several "H3"), by the same rule as the search of barcos.
   */
  barcoEtiqueta: string
  /** The packages Odoo has waiting for delivery. 0 for a barco whose packages are all still unsent. */
  paquetes: number
  /** Since when the oldest of those deliveries has been waiting. Null when Odoo has none for the barco. */
  desde: Date | null
  /** The packages received but not in Odoo yet, in open recepciones: they cannot be delivered until they are sent. */
  sinEnviar: number
}

/**
 * Oldest `desde` first, the barcos with none last. Barcos that tie go by name, then by id, so that the
 * list does not reshuffle between one read and the next.
 */
function porAntiguedad(a: BarcoParaEntregar, b: BarcoParaEntregar): number {
  const desdeA = a.desde?.getTime() ?? Infinity
  const desdeB = b.desde?.getTime() ?? Infinity
  if (desdeA !== desdeB) return desdeA < desdeB ? -1 : 1
  return a.barcoNombre.localeCompare(b.barcoNombre, 'es') || a.barcoOdooId - b.barcoOdooId
}

/**
 * The barcos to choose from on the delivery screen: those with a delivery waiting in the almacén's
 * delivery type (a live read of Odoo), each with how many of its packages are received but not sent
 * to Odoo yet. A barco whose packages are all still unsent has nothing in Odoo, so it is added to the
 * list with 0 packages and no date, and its name from the cache: otherwise there would be no way to
 * see that its packages are waiting to be sent. Oldest first, those with no date last.
 *
 * Without a delivery type in the almacén nothing can be read, and an admin has to refresh the data.
 */
export async function listarBarcosParaEntregar(almacen: Pick<Almacen, 'id' | 'odooOutTypeId'>): Promise<BarcoParaEntregar[]> {
  if (!almacen.odooOutTypeId) {
    throw new ConfiguracionError('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')
  }

  const [enOdoo, sinEnviar] = await Promise.all([
    getBarcosConEntregaPendiente(almacen.odooOutTypeId),
    contarSinEnviarPorBarco(almacen.id),
  ])

  // Without the label yet: it is told when the list is complete, since it depends on the names of all of it.
  const barcos: Array<Omit<BarcoParaEntregar, 'barcoEtiqueta'>> = enOdoo.map((barco) => ({
    ...barco,
    sinEnviar: sinEnviar.get(barco.barcoOdooId) ?? 0,
  }))

  const yaEstan = new Set(barcos.map((barco) => barco.barcoOdooId))
  const soloSinEnviar = [...sinEnviar].filter(([barcoOdooId]) => !yaEstan.has(barcoOdooId))
  // Most of the time there is none, and then the cache is not read at all.
  if (soloSinEnviar.length > 0) {
    const nombres = new Map(
      (await db.select({ odooId: barcosCache.odooId, nombre: barcosCache.nombre })
        .from(barcosCache)
        .where(inArray(barcosCache.odooId, soloSinEnviar.map(([barcoOdooId]) => barcoOdooId))))
        .map((barco) => [barco.odooId, barco.nombre]),
    )
    for (const [barcoOdooId, cantidad] of soloSinEnviar) {
      barcos.push({
        barcoOdooId,
        barcoNombre: nombreDelBarco(nombres.get(barcoOdooId), barcoOdooId),
        paquetes: 0,
        desde: null,
        sinEnviar: cantidad,
      })
    }
  }

  const etiquetas = etiquetasDeBarcos(barcos.map((barco) => ({ odooId: barco.barcoOdooId, nombre: barco.barcoNombre })))
  const conEtiqueta: BarcoParaEntregar[] = barcos.map((barco, posicion) => ({ ...barco, barcoEtiqueta: etiquetas[posicion] }))
  return conEtiqueta.sort(porAntiguedad)
}

/** The `data:image/png;base64,` that a canvas puts in front of the image: Odoo's `signature` wants what comes after it. */
const PREFIJO_DATA_URL = /^data:[^,]*;base64,/i

/** The kinds of sesión the phone confirms with an id it made up: what `guardarYEncolar` and `sesionGuardada` take. */
export type TipoConfirmadoEnElMovil = 'entrega' | 'reasignacion'

/** A sesión the phone confirmed, as it is saved: with the id the phone made up, and of a kind it confirms. */
export type SesionConfirmada = typeof sesionesEscaneo.$inferInsert & { id: string; tipo: TipoConfirmadoEnElMovil }

/**
 * Saves a sesión the phone confirmed (an entrega, a reasignación) and queues it: the worker is the only one that writes
 * it to Odoo. It is saved straight as `confirmada_pendiente_sync`: what the phone sends is what was confirmed.
 *
 * Idempotent by `id`. The phone makes the id up before its first try, so a second try with it (the connection
 * dropped and the answer never came) finds the sesión already saved: it is not saved or audited a second time.
 * If that sesión is still waiting for its sync, the retry queues it again. The first try may have saved it and
 * failed to queue it (QStash down), and answering "registered" with nothing queued would hide that. A second
 * message does no harm: the queue runs one job at a time, and the worker does nothing for a sesión that is not
 * waiting for its sync any more. One that is not (synced, or failed for good, which goes back through
 * Pendientes' "Reintentar") is left alone, and so is an id that belongs to another kind of sesión.
 *
 * The confirmation is audited right after the save, before queuing, so it is recorded exactly once: it was
 * confirmed whatever happens to the queue, and the retry that has to queue it audits nothing.
 *
 * If queuing fails, in either try, the error goes through and the sesión stays as it is. It is not deleted: a
 * repeated try may have found it meanwhile. A retry with the same id queues it; if nobody retries, Pendientes
 * lists it as stuck after a while.
 */
export async function guardarYEncolar(entrada: {
  sesion: SesionConfirmada
  auditoria: { accion: AccionAuditoria; detalle: Record<string, unknown> }
}): Promise<void> {
  const { sesion, auditoria } = entrada

  const [creada] = await db.insert(sesionesEscaneo)
    .values({ ...sesion, estado: 'confirmada_pendiente_sync', confirmedAt: new Date() })
    .onConflictDoNothing()
    .returning({ id: sesionesEscaneo.id })

  if (!creada) {
    // An earlier try saved it and audited it: no audit here. It is queued again only if it is still waiting for its
    // sync, which is also true when the first try did queue it and the worker has not got to it.
    const existente = await db.query.sesionesEscaneo.findFirst({
      columns: { estado: true },
      where: and(eq(sesionesEscaneo.id, sesion.id), eq(sesionesEscaneo.tipo, sesion.tipo)),
    })
    if (existente?.estado === 'confirmada_pendiente_sync') await publishSync({ sesionId: sesion.id })
    return
  }

  // Audited before queuing: the confirmation is a fact as soon as the sesión is saved, whatever then happens to the
  // queue. That way it is recorded exactly once, also when publishing fails here and a retry has to queue it.
  // (It never throws, so it cannot get in the way of queuing.)
  await registrarAuditoria({ operarioId: sesion.operarioId, accion: auditoria.accion, detalle: auditoria.detalle })

  await publishSync({ sesionId: sesion.id })
}

/**
 * Registers the delivery the crew confirmed and queues it, once per `id` (see `guardarYEncolar`). The name is trimmed,
 * and the signature is stored as bare base64, which is what Odoo takes. `paquetes` is what those lines are (package,
 * courier, delivery), kept with them so that Pendientes and the search of a package can tell which packages the entrega
 * handed over.
 */
export async function registrarEntrega(entrada: {
  id: string
  operarioId: string
  almacenId: number
  barcoOdooId: number
  pickingIds: number[]
  moveLineIds: number[]
  paquetes: PaqueteDeOdoo[]
  receptorNombre: string
  firmaBase64: string
}): Promise<void> {
  const { id, operarioId, almacenId, barcoOdooId, moveLineIds } = entrada

  await guardarYEncolar({
    sesion: {
      id,
      operarioId,
      almacenId,
      barcoOdooId,
      tipo: 'entrega',
      odooPickingIds: entrada.pickingIds,
      odooMoveLineIds: moveLineIds,
      paquetesDeOdoo: entrada.paquetes,
      receptorNombre: entrada.receptorNombre.trim(),
      firmaData: entrada.firmaBase64.trim().replace(PREFIJO_DATA_URL, ''),
    },
    auditoria: { accion: 'entrega_confirmada', detalle: { sesionId: id, almacenId, barcoOdooId, paquetes: moveLineIds.length } },
  })
}

/**
 * Whether a sesión of this kind with this id was saved in this almacén, in whatever estado: the id of a retry of one that
 * an earlier try saved. Such a retry has nothing left to check against Odoo, since what the sesión holds may be
 * delivered or moved by now, and `guardarYEncolar` is the one that knows what to do with it.
 */
export async function sesionGuardada(entrada: { id: string; tipo: TipoConfirmadoEnElMovil; almacenId: number }): Promise<boolean> {
  const existente = await db.query.sesionesEscaneo.findFirst({
    columns: { id: true },
    where: and(
      eq(sesionesEscaneo.id, entrada.id),
      eq(sesionesEscaneo.tipo, entrada.tipo),
      eq(sesionesEscaneo.almacenId, entrada.almacenId),
    ),
  })
  return existente !== undefined
}

/**
 * The move lines of the barco in the almacén that an entrega or a reasignación still waiting for its sync
 * (`confirmada_pendiente_sync`) has taken, each with why: an entrega hands it over, a reasignación moves it to the barco
 * its `Retencion` names. The worker has not got to them yet, so Odoo still lists those lines as waiting for the barco: they
 * must not be offered again, nor accepted by a second entrega or reasignación, or the same packages would be handed over
 * twice, or handed over while they are being moved.
 *
 * Only that estado holds. A synced sesión's lines are no longer pending for the barco in Odoo, and one that failed did
 * nothing with them: they go back through Pendientes, and meanwhile they are not stuck.
 *
 * `exceptoId` leaves out one sesión: the one being confirmed again. A retry with the same id finds its own lines held,
 * and they must not block it.
 */
export async function lineasRetenidas(entrada: {
  almacenId: number
  barcoOdooId: number
  exceptoId?: string
}): Promise<Map<number, Retencion>> {
  const filas = await db.select({
    tipo: sesionesEscaneo.tipo,
    lineas: sesionesEscaneo.odooMoveLineIds,
    barcoDestinoOdooId: sesionesEscaneo.barcoDestinoOdooId,
    barcoDestinoNombre: barcosCache.nombre,
  })
    .from(sesionesEscaneo)
    .leftJoin(barcosCache, eq(barcosCache.odooId, sesionesEscaneo.barcoDestinoOdooId))
    .where(and(
      eq(sesionesEscaneo.almacenId, entrada.almacenId),
      eq(sesionesEscaneo.barcoOdooId, entrada.barcoOdooId),
      inArray(sesionesEscaneo.tipo, ['entrega', 'reasignacion']),
      eq(sesionesEscaneo.estado, 'confirmada_pendiente_sync'),
      entrada.exceptoId === undefined ? undefined : ne(sesionesEscaneo.id, entrada.exceptoId),
    ))

  const retenidas = new Map<number, Retencion>()
  for (const fila of filas) {
    const retencion: Retencion = fila.tipo === 'reasignacion' && fila.barcoDestinoOdooId !== null
      ? { tipo: 'reasignacion', barcoNombre: nombreDelBarco(fila.barcoDestinoNombre, fila.barcoDestinoOdooId) }
      : { tipo: 'entrega' }
    for (const linea of fila.lineas ?? []) retenidas.set(linea, retencion)
  }
  return retenidas
}

/** An entrega confirmed today. */
export interface EntregaDeHoy {
  id: string
  barcoNombre: string
  /** The packages that were handed over: the lines chosen. */
  paquetes: number
  /** Who received them, as the crew member typed it. */
  receptorNombre: string
  /** `enviando`: waiting for the worker. `ok`: it is in Odoo. `problema`: it failed, or it went in with a note. */
  estado: 'enviando' | 'ok' | 'problema'
}

/** Entregas that were confirmed, whatever became of their sync. */
const ESTADOS_CONFIRMADA: SesionEscaneo['estado'][] = ['confirmada_pendiente_sync', 'sincronizada', 'error']

/** How the sync of an entrega that was confirmed is going: what Entregadas hoy says of it, and the search of a package too. */
export function estadoDeEntrega(estado: SesionEscaneo['estado'], ultimoError: string | null): EntregaDeHoy['estado'] {
  if (estado === 'confirmada_pendiente_sync') return 'enviando'
  // The same rule as for the recepciones: a sync that left a note in `ultimoError` is not a clean one.
  return estado === 'sincronizada' && !ultimoError ? 'ok' : 'problema'
}

/**
 * The entregas of the almacén that were confirmed since 00:00 of the day `ahora` falls on in Madrid, in the
 * order they were confirmed, each with who received it and how its sync is going.
 */
export async function listarEntregadasHoy(almacenId: number, ahora: Date = new Date()): Promise<EntregaDeHoy[]> {
  const filas = await db.select({
    id: sesionesEscaneo.id,
    barcoOdooId: sesionesEscaneo.barcoOdooId,
    barcoNombre: barcosCache.nombre,
    receptorNombre: sesionesEscaneo.receptorNombre,
    lineas: sesionesEscaneo.odooMoveLineIds,
    estado: sesionesEscaneo.estado,
    ultimoError: sesionesEscaneo.ultimoError,
  })
    .from(sesionesEscaneo)
    .leftJoin(barcosCache, eq(barcosCache.odooId, sesionesEscaneo.barcoOdooId))
    .where(and(
      eq(sesionesEscaneo.almacenId, almacenId),
      eq(sesionesEscaneo.tipo, 'entrega'),
      inArray(sesionesEscaneo.estado, ESTADOS_CONFIRMADA),
      gte(sesionesEscaneo.confirmedAt, inicioDeHoy(ahora)),
    ))
    .orderBy(asc(sesionesEscaneo.confirmedAt), asc(sesionesEscaneo.id))

  return filas.map((fila) => ({
    id: fila.id,
    barcoNombre: nombreDelBarco(fila.barcoNombre, fila.barcoOdooId),
    paquetes: fila.lineas?.length ?? 0,
    receptorNombre: fila.receptorNombre ?? '',
    estado: estadoDeEntrega(fila.estado, fila.ultimoError),
  }))
}
