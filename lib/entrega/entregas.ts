import { and, asc, eq, gte, inArray, ne } from 'drizzle-orm'
import { db } from '../../db/client'
import { barcosCache, sesionesEscaneo, type Almacen, type PaqueteEntregado, type SesionEscaneo } from '../../db/schema'
import { registrarAuditoria } from '../audit'
import { etiquetasDeBarcos } from '../cache/barcos'
import { ConfiguracionError } from '../errores'
import { inicioDeHoy } from '../fechas'
import { getBarcosConEntregaPendiente } from '../odoo/pickings'
import { publishSync } from '../queue/publish'
import { contarSinEnviarPorBarco } from '../recepcion/recepciones'

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

/**
 * Registers the delivery the crew confirmed and queues it: the worker is the only one that writes it to Odoo.
 *
 * Idempotent by `id`. The phone makes the id up before its first try, so a second try with it (the connection
 * dropped and the answer never came) finds the entrega already saved: it is not saved or audited a second time.
 * If that entrega is still waiting for its sync, the retry queues it again. The first try may have saved it and
 * failed to queue it (QStash down), and answering "registered" with nothing queued would hide that. A second
 * message does no harm: the queue runs one job at a time, and the worker does nothing for an entrega that is not
 * waiting for its sync any more. One that is not (synced, or failed for good, which goes back through
 * Pendientes' "Reintentar") is left alone, and so is an id that belongs to something other than an entrega.
 *
 * The confirmation is audited right after the save, before queuing, so it is recorded exactly once: the crew
 * confirmed it whatever happens to the queue, and the retry that has to queue it audits nothing.
 *
 * It is saved straight as `confirmada_pendiente_sync`: an entrega has no earlier stage, since what the phone
 * sends is what the crew confirmed. The name is trimmed, and the signature is stored as bare base64, which is
 * what Odoo takes. `paquetes` is what those lines are (package, courier, delivery), kept with them so that Pendientes
 * and the search of a package can tell which packages the entrega handed over.
 *
 * If queuing fails, in either try, the error goes through and the entrega stays as it is. It is not deleted: a
 * repeated try may have found it meanwhile. A retry with the same id queues it; if nobody retries, Pendientes
 * lists it as stuck after a while.
 */
export async function registrarEntrega(entrada: {
  id: string
  operarioId: string
  almacenId: number
  barcoOdooId: number
  pickingIds: number[]
  moveLineIds: number[]
  paquetes: PaqueteEntregado[]
  receptorNombre: string
  firmaBase64: string
}): Promise<void> {
  const { id, operarioId, almacenId, barcoOdooId, moveLineIds } = entrada

  const [creada] = await db.insert(sesionesEscaneo)
    .values({
      id,
      operarioId,
      almacenId,
      barcoOdooId,
      tipo: 'entrega',
      estado: 'confirmada_pendiente_sync',
      odooPickingIds: entrada.pickingIds,
      odooMoveLineIds: moveLineIds,
      paquetesEntrega: entrada.paquetes,
      receptorNombre: entrada.receptorNombre.trim(),
      firmaData: entrada.firmaBase64.trim().replace(PREFIJO_DATA_URL, ''),
      confirmedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: sesionesEscaneo.id })

  if (!creada) {
    // An earlier try saved it and audited it: no audit here. It is queued again only if it is still waiting for its
    // sync, which is also true when the first try did queue it and the worker has not got to it.
    const existente = await db.query.sesionesEscaneo.findFirst({
      columns: { estado: true },
      where: and(eq(sesionesEscaneo.id, id), eq(sesionesEscaneo.tipo, 'entrega')),
    })
    if (existente?.estado === 'confirmada_pendiente_sync') await publishSync({ sesionId: id })
    return
  }

  // Audited before queuing: the crew's confirmation is a fact as soon as the entrega is saved, whatever then happens
  // to the queue. That way it is recorded exactly once, also when publishing fails here and a retry has to queue it.
  // (It never throws, so it cannot get in the way of queuing.)
  await registrarAuditoria({
    operarioId,
    accion: 'entrega_confirmada',
    detalle: { sesionId: id, almacenId, barcoOdooId, paquetes: moveLineIds.length },
  })

  await publishSync({ sesionId: id })
}

/**
 * Whether an entrega with this id was saved in this almacén, in whatever estado: the id of a retry of one that an
 * earlier try saved. Such a retry has nothing left to check against Odoo, since what the entrega holds may be
 * delivered by now, and `registrarEntrega` is the one that knows what to do with it.
 */
export async function entregaGuardada(id: string, almacenId: number): Promise<boolean> {
  const existente = await db.query.sesionesEscaneo.findFirst({
    columns: { id: true },
    where: and(eq(sesionesEscaneo.id, id), eq(sesionesEscaneo.tipo, 'entrega'), eq(sesionesEscaneo.almacenId, almacenId)),
  })
  return existente !== undefined
}

/**
 * The move lines that an entrega of the almacén for the barco, still waiting for its sync (`confirmada_pendiente_sync`),
 * has taken. The worker has not got to it yet, so Odoo still lists those lines as pending: they must not be offered
 * again, nor accepted by a second entrega, or the same packages would be handed over twice.
 *
 * Only that estado holds. A synced entrega's lines are no longer pending in Odoo, and one that failed delivered
 * nothing: its packages go back through Pendientes, and meanwhile they are not stuck.
 *
 * `exceptoId` leaves out one entrega: the one being confirmed again. A retry with the same id finds its own lines held,
 * and they must not block it.
 */
export async function moveLineIdsRetenidas(entrada: {
  almacenId: number
  barcoOdooId: number
  exceptoId?: string
}): Promise<Set<number>> {
  const filas = await db.select({ lineas: sesionesEscaneo.odooMoveLineIds })
    .from(sesionesEscaneo)
    .where(and(
      eq(sesionesEscaneo.almacenId, entrada.almacenId),
      eq(sesionesEscaneo.barcoOdooId, entrada.barcoOdooId),
      eq(sesionesEscaneo.tipo, 'entrega'),
      eq(sesionesEscaneo.estado, 'confirmada_pendiente_sync'),
      entrada.exceptoId === undefined ? undefined : ne(sesionesEscaneo.id, entrada.exceptoId),
    ))
  return new Set(filas.flatMap((fila) => fila.lineas ?? []))
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
