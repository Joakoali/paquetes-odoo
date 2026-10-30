import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '../../db/client'
import { almacenes, barcosCache, couriers, operarios, sesionCourierBatches, sesionItems, sesionesEscaneo } from '../../db/schema'
import { escaparLike } from '../cache/barcos'
import { estadoDeEntrega, nombreDelBarco, type EntregaDeHoy } from '../entrega/entregas'
import { buscarEnOdoo, type LineaEncontradaEnOdoo, type Operacion } from '../odoo/busqueda'
import { estadoDeEnvio, type RecepcionEnviada } from '../recepcion/recepciones'
import { coincideTracking, MIN_CARACTERES_BUSQUEDA, normalizarTracking } from '../ui/busqueda-tracking'
import { mensajeDeLecturaFallida } from '../ui/lectura-fallida'

/*
 * Where a package is: everything the webapp and Odoo know of a tracking number, so that whoever asks (the crew, an
 * operario with a package in hand) gets the whole of it in one place. It is read for every almacén: what the operario may
 * open of it is for the screen to decide (`enlaceDeLugar`), which is why every place says its almacén.
 */

/** How many rows each source gives at most: the recepciones, the entregas and the lines of Odoo. */
export const LIMITE_POR_FUENTE = 50

/** How many packages a search shows at most. More means that what was typed is too short to tell them apart. */
export const LIMITE_PAQUETES = 20

/** What every place a package is found in says: which package, where, and when. */
interface LugarBase {
  /** The tracking number as this place has it. */
  trackingNumber: string
  /** The almacén of the place. Null for a picking of an operation type the app does not know. */
  almacenId: number | null
  almacenPrefijo: string | null
  /** Null for a picking that Odoo has not given a barco yet. */
  barcoOdooId: number | null
  barcoNombre: string | null
  fecha: Date
}

/** A recepción of the webapp the package was scanned into. */
export interface LugarRecepcion extends LugarBase {
  tipo: 'recepcion'
  sesionId: string
  /** `abierta`: still being scanned into, not sent. The rest, as Enviadas hoy says it of a recepción. */
  estado: 'abierta' | RecepcionEnviada['estado']
  /** The picking the recepción made in Odoo, once it made one. */
  odooPickingRef: string | null
  /** Who scanned it. */
  operarioNombre: string
  /** Odoo already had it (at `duplicadoRef`), so it was not sent with the recepción. */
  duplicado: boolean
  duplicadoRef: string | null
}

/** An entrega of the webapp that handed the package over. */
export interface LugarEntrega extends LugarBase {
  tipo: 'entrega'
  sesionId: string
  estado: EntregaDeHoy['estado']
  /** The delivery of Odoo the package was on. */
  pickingRef: string
  receptorNombre: string | null
}

/** A reasignación of the webapp that moved the package to another barco. Its barco is the one it was taken from. */
export interface LugarReasignacion extends LugarBase {
  tipo: 'reasignacion'
  sesionId: string
  estado: EntregaDeHoy['estado']
  /** The barco the package went to. */
  barcoDestinoOdooId: number
  barcoDestinoNombre: string
  /** The delivery of Odoo it went into, once the worker took one. */
  destinoRef: string | null
  /** Who moved it. */
  operarioNombre: string
}

/** A picking of Odoo the package is on. */
export interface LugarOdoo extends LugarBase {
  tipo: 'odoo'
  operacion: Operacion
  hecho: boolean
  pickingRef: string
  recibidoPor: string | null
}

export type LugarDelPaquete = LugarRecepcion | LugarEntrega | LugarReasignacion | LugarOdoo

export interface PaqueteEncontrado {
  trackingNumber: string
  courierNombre: string | null
  /** Where it has been, in the order it happened: received first, delivered last. */
  lugares: LugarDelPaquete[]
}

export interface BusquedaDePaquetes {
  /** The exact match first, then the packages with the newest news. */
  paquetes: PaqueteEncontrado[]
  /** There were more than are shown: more of the number narrows it down. */
  hayMas: boolean
  /** Why Odoo could not be read, when it could not: then what is shown is only what the webapp has. */
  odooFallo: string | null
}

/** A place, with the courier its package goes under: what each source gives. */
type Hallazgo = { lugar: LugarDelPaquete; courierNombre: string | null }

/** What a source found, and whether it had more than it gave. */
interface DeUnaFuente {
  hallazgos: Hallazgo[]
  hayMas: boolean
}

/**
 * Whether the text of `columna`, without blanks and in lower case, contains `buscado`, which comes like that: what
 * `coincideTracking` says, as SQL. What the operario typed is literal text (`escaparLike`).
 */
function contiene(columna: AnyPgColumn | SQL, buscado: string): SQL {
  return sql`regexp_replace(lower(${columna}), '[[:space:]]', '', 'g') like ${`%${escaparLike(buscado)}%`}`
}

/** Whether one of the packages an entrega or a reasignación kept (`paquetes_entrega`) has what is searched, as SQL. */
function algunPaqueteContiene(buscado: string): SQL {
  return sql`exists (select 1 from jsonb_array_elements(${sesionesEscaneo.paquetesDeOdoo}) as paquete where ${contiene(sql`paquete ->> 'trackingNumber'`, buscado)})`
}

/** Every package of a recepción of the webapp that has it, the last scanned first. */
async function enRecepciones(buscado: string): Promise<DeUnaFuente> {
  const filas = await db.select({
    trackingNumber: sesionItems.trackingNumber,
    itemEstado: sesionItems.estado,
    duplicadoRef: sesionItems.duplicadoRef,
    escaneadoAt: sesionItems.createdAt,
    courierNombre: couriers.nombre,
    sesionId: sesionesEscaneo.id,
    estado: sesionesEscaneo.estado,
    ultimoError: sesionesEscaneo.ultimoError,
    odooPickingRef: sesionesEscaneo.odooPickingRef,
    almacenId: sesionesEscaneo.almacenId,
    almacenPrefijo: almacenes.prefijo,
    barcoOdooId: sesionesEscaneo.barcoOdooId,
    barcoNombre: barcosCache.nombre,
    operarioNombre: operarios.nombre,
  })
    .from(sesionItems)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.id, sesionItems.courierBatchId))
    .innerJoin(sesionesEscaneo, eq(sesionesEscaneo.id, sesionCourierBatches.sesionId))
    .innerJoin(couriers, eq(couriers.id, sesionCourierBatches.courierId))
    .innerJoin(almacenes, eq(almacenes.id, sesionesEscaneo.almacenId))
    .leftJoin(barcosCache, eq(barcosCache.odooId, sesionesEscaneo.barcoOdooId))
    // Who scanned it, or, for a package from before the webapp kept that, who opened the recepción.
    .innerJoin(operarios, eq(operarios.id, sql`coalesce(${sesionItems.operarioId}, ${sesionesEscaneo.operarioId})`))
    .where(and(eq(sesionesEscaneo.tipo, 'recepcion'), contiene(sesionItems.trackingNumber, buscado)))
    .orderBy(desc(sesionItems.createdAt), desc(sesionItems.id))
    .limit(LIMITE_POR_FUENTE + 1)

  return {
    hayMas: filas.length > LIMITE_POR_FUENTE,
    hallazgos: filas.slice(0, LIMITE_POR_FUENTE).map((fila) => ({
      courierNombre: fila.courierNombre,
      lugar: {
        tipo: 'recepcion',
        trackingNumber: fila.trackingNumber,
        almacenId: fila.almacenId,
        almacenPrefijo: fila.almacenPrefijo,
        barcoOdooId: fila.barcoOdooId,
        barcoNombre: nombreDelBarco(fila.barcoNombre, fila.barcoOdooId),
        fecha: fila.escaneadoAt,
        sesionId: fila.sesionId,
        estado: fila.estado === 'en_curso' ? 'abierta' : estadoDeEnvio(fila.estado, fila.ultimoError),
        odooPickingRef: fila.odooPickingRef,
        operarioNombre: fila.operarioNombre,
        duplicado: fila.itemEstado === 'duplicado',
        duplicadoRef: fila.duplicadoRef,
      },
    })),
  }
}

/**
 * Every package that an entrega of the webapp handed over and has it, the last entrega first. The database finds the
 * entregas (any of whose packages has it) and the packages that do are taken here, by the same rule.
 */
async function enEntregas(buscado: string): Promise<DeUnaFuente> {
  const filas = await db.select({
    sesionId: sesionesEscaneo.id,
    estado: sesionesEscaneo.estado,
    ultimoError: sesionesEscaneo.ultimoError,
    almacenId: sesionesEscaneo.almacenId,
    almacenPrefijo: almacenes.prefijo,
    barcoOdooId: sesionesEscaneo.barcoOdooId,
    barcoNombre: barcosCache.nombre,
    receptorNombre: sesionesEscaneo.receptorNombre,
    confirmedAt: sesionesEscaneo.confirmedAt,
    createdAt: sesionesEscaneo.createdAt,
    paquetes: sesionesEscaneo.paquetesDeOdoo,
  })
    .from(sesionesEscaneo)
    .innerJoin(almacenes, eq(almacenes.id, sesionesEscaneo.almacenId))
    .leftJoin(barcosCache, eq(barcosCache.odooId, sesionesEscaneo.barcoOdooId))
    .where(and(eq(sesionesEscaneo.tipo, 'entrega'), algunPaqueteContiene(buscado)))
    .orderBy(desc(sesionesEscaneo.confirmedAt), desc(sesionesEscaneo.id))
    .limit(LIMITE_POR_FUENTE + 1)

  return {
    hayMas: filas.length > LIMITE_POR_FUENTE,
    hallazgos: filas.slice(0, LIMITE_POR_FUENTE).flatMap((fila) => (fila.paquetes ?? []).flatMap((paquete): Hallazgo[] => (
      paquete.trackingNumber !== null && coincideTracking(paquete.trackingNumber, buscado)
        ? [{
            courierNombre: paquete.courierNombre,
            lugar: {
              tipo: 'entrega',
              trackingNumber: paquete.trackingNumber,
              almacenId: fila.almacenId,
              almacenPrefijo: fila.almacenPrefijo,
              barcoOdooId: fila.barcoOdooId,
              barcoNombre: nombreDelBarco(fila.barcoNombre, fila.barcoOdooId),
              // Every entrega is saved confirmed; `createdAt` only keeps the type honest.
              fecha: fila.confirmedAt ?? fila.createdAt,
              sesionId: fila.sesionId,
              estado: estadoDeEntrega(fila.estado, fila.ultimoError),
              pickingRef: paquete.pickingRef,
              receptorNombre: fila.receptorNombre,
            },
          }]
        : []
    ))),
  }
}

/**
 * Every package that a reasignación of the webapp moved to another barco and has it, the last one first: found as the
 * entregas are, by the packages it kept.
 */
async function enReasignaciones(buscado: string): Promise<DeUnaFuente> {
  const barcoDestino = alias(barcosCache, 'barco_destino')
  const filas = await db.select({
    sesionId: sesionesEscaneo.id,
    estado: sesionesEscaneo.estado,
    ultimoError: sesionesEscaneo.ultimoError,
    almacenId: sesionesEscaneo.almacenId,
    almacenPrefijo: almacenes.prefijo,
    barcoOdooId: sesionesEscaneo.barcoOdooId,
    barcoNombre: barcosCache.nombre,
    barcoDestinoOdooId: sesionesEscaneo.barcoDestinoOdooId,
    barcoDestinoNombre: barcoDestino.nombre,
    destinoRef: sesionesEscaneo.odooPickingRef,
    operarioNombre: operarios.nombre,
    confirmedAt: sesionesEscaneo.confirmedAt,
    createdAt: sesionesEscaneo.createdAt,
    paquetes: sesionesEscaneo.paquetesDeOdoo,
  })
    .from(sesionesEscaneo)
    .innerJoin(almacenes, eq(almacenes.id, sesionesEscaneo.almacenId))
    .innerJoin(operarios, eq(operarios.id, sesionesEscaneo.operarioId))
    .leftJoin(barcosCache, eq(barcosCache.odooId, sesionesEscaneo.barcoOdooId))
    .leftJoin(barcoDestino, eq(barcoDestino.odooId, sesionesEscaneo.barcoDestinoOdooId))
    .where(and(eq(sesionesEscaneo.tipo, 'reasignacion'), algunPaqueteContiene(buscado)))
    .orderBy(desc(sesionesEscaneo.confirmedAt), desc(sesionesEscaneo.id))
    .limit(LIMITE_POR_FUENTE + 1)

  return {
    hayMas: filas.length > LIMITE_POR_FUENTE,
    hallazgos: filas.slice(0, LIMITE_POR_FUENTE).flatMap((fila) => (fila.paquetes ?? []).flatMap((paquete): Hallazgo[] => (
      // Every reasignación has a barco destino; the check is for the types.
      paquete.trackingNumber !== null && fila.barcoDestinoOdooId !== null && coincideTracking(paquete.trackingNumber, buscado)
        ? [{
            courierNombre: paquete.courierNombre,
            lugar: {
              tipo: 'reasignacion',
              trackingNumber: paquete.trackingNumber,
              almacenId: fila.almacenId,
              almacenPrefijo: fila.almacenPrefijo,
              barcoOdooId: fila.barcoOdooId,
              barcoNombre: nombreDelBarco(fila.barcoNombre, fila.barcoOdooId),
              fecha: fila.confirmedAt ?? fila.createdAt,
              sesionId: fila.sesionId,
              estado: estadoDeEntrega(fila.estado, fila.ultimoError),
              barcoDestinoOdooId: fila.barcoDestinoOdooId,
              barcoDestinoNombre: nombreDelBarco(fila.barcoDestinoNombre, fila.barcoDestinoOdooId),
              destinoRef: fila.destinoRef,
              operarioNombre: fila.operarioNombre,
            },
          }]
        : []
    ))),
  }
}

/** The almacén of each operation type of Odoo, reception and delivery: what tells where a picking is. */
async function almacenesPorTipo(): Promise<Map<number, { id: number; prefijo: string }>> {
  const filas = await db.select({
    id: almacenes.id, prefijo: almacenes.prefijo, inTypeId: almacenes.odooInTypeId, outTypeId: almacenes.odooOutTypeId,
  }).from(almacenes)
  const porTipo = new Map<number, { id: number; prefijo: string }>()
  for (const { id, prefijo, inTypeId, outTypeId } of filas) {
    if (inTypeId !== null) porTipo.set(inTypeId, { id, prefijo })
    if (outTypeId !== null) porTipo.set(outTypeId, { id, prefijo })
  }
  return porTipo
}

/** A line of Odoo as a place, its almacén told by the operation type of its picking. */
function lugarDeOdoo(linea: LineaEncontradaEnOdoo, porTipo: Map<number, { id: number; prefijo: string }>): LugarOdoo {
  const almacen = linea.pickingTypeId === null ? undefined : porTipo.get(linea.pickingTypeId)
  return {
    tipo: 'odoo',
    trackingNumber: linea.trackingNumber,
    almacenId: almacen?.id ?? null,
    almacenPrefijo: almacen?.prefijo ?? null,
    barcoOdooId: linea.barco?.odooId ?? null,
    barcoNombre: linea.barco?.nombre ?? null,
    fecha: linea.fecha,
    operacion: linea.operacion,
    hecho: linea.hecho,
    pickingRef: linea.pickingRef,
    recibidoPor: linea.recibidoPor,
  }
}

/**
 * The lines of Odoo whose package has it, or what to tell the operario when Odoo could not be read. Only a reading that
 * failed is told: a bug goes on to the error screen, as on the screens of Entrega.
 */
async function leerOdoo(buscado: string): Promise<{ lineas: LineaEncontradaEnOdoo[] } | { fallo: string }> {
  try {
    return { lineas: await buscarEnOdoo({ buscado, limite: LIMITE_POR_FUENTE + 1 }) }
  } catch (error) {
    const fallo = mensajeDeLecturaFallida(error)
    if (fallo === null) throw error
    return { fallo }
  }
}

/**
 * What Odoo has, each picking with its almacén, or why it could not be read. The almacenes are read from the database
 * apart from Odoo, so that a failure of the database is not told as one of Odoo.
 */
async function enOdoo(buscado: string): Promise<DeUnaFuente & { fallo: string | null }> {
  const [lectura, porTipo] = await Promise.all([leerOdoo(buscado), almacenesPorTipo()])
  if ('fallo' in lectura) return { hallazgos: [], hayMas: false, fallo: lectura.fallo }

  const { lineas } = lectura
  return {
    hayMas: lineas.length > LIMITE_POR_FUENTE,
    hallazgos: lineas.slice(0, LIMITE_POR_FUENTE).map((linea) => ({ courierNombre: linea.courierNombre, lugar: lugarDeOdoo(linea, porTipo) })),
    fallo: null,
  }
}

/**
 * The picking a place of the webapp already stands for, if any: the one a recepción made, for a package it did send, and
 * the delivery an entrega took the package from. The same picking read from Odoo says less (not who scanned, not that the
 * entrega is still on its way, while Odoo goes on listing it as waiting), so it is not shown twice. A reasignación stands
 * for none: the deliveries it took the package from and to are where Odoo says the package waits, and are told as such.
 */
function pickingQueRepresenta(lugar: LugarDelPaquete): string | null {
  if (lugar.tipo === 'recepcion') return lugar.duplicado ? null : lugar.odooPickingRef
  if (lugar.tipo === 'entrega') return lugar.pickingRef
  return null
}

/** The newest news of a package: when its last place happened. */
const ultimaFecha = (paquete: PaqueteEncontrado) => Math.max(...paquete.lugares.map((lugar) => lugar.fecha.getTime()))

/**
 * Where the packages whose tracking number contains `buscado` are, in the webapp (its recepciones, entregas and
 * reasignaciones) and in Odoo, which are read at once. `buscado` is what `textoDeBusqueda` gave: shorter than MIN_CARACTERES_BUSQUEDA, nothing is
 * read. Each package is told once, whatever the case and the blanks each place writes it with, with its places in the
 * order they happened; the one whose number is exactly what was searched goes first, then the newest news.
 *
 * Odoo is read live (two requests, see `buscarEnOdoo`). When it cannot be, what the webapp has is still given, with why.
 */
export async function buscarPaquetes(buscado: string): Promise<BusquedaDePaquetes> {
  const texto = normalizarTracking(buscado)
  if (texto.length < MIN_CARACTERES_BUSQUEDA) return { paquetes: [], hayMas: false, odooFallo: null }

  const [recepciones, entregas, reasignaciones, odoo] = await Promise.all([
    enRecepciones(texto), enEntregas(texto), enReasignaciones(texto), enOdoo(texto),
  ])

  const porTracking = new Map<string, PaqueteEncontrado>()
  const hallazgos = [...recepciones.hallazgos, ...entregas.hallazgos, ...reasignaciones.hallazgos, ...odoo.hallazgos]
  for (const { lugar, courierNombre } of hallazgos) {
    const clave = normalizarTracking(lugar.trackingNumber)
    const paquete = porTracking.get(clave) ?? { trackingNumber: lugar.trackingNumber, courierNombre: null, lugares: [] }
    // The courier as the first place that names one says it.
    if (paquete.courierNombre === null) paquete.courierNombre = courierNombre
    paquete.lugares.push(lugar)
    porTracking.set(clave, paquete)
  }

  const paquetes = [...porTracking.entries()].map(([clave, paquete]) => {
    const representados = new Set(paquete.lugares.map(pickingQueRepresenta).filter((ref) => ref !== null))
    const lugares = paquete.lugares
      .filter((lugar) => lugar.tipo !== 'odoo' || !representados.has(lugar.pickingRef))
      // A stable sort: two places of the same moment keep the order above, the webapp's first.
      .sort((a, b) => a.fecha.getTime() - b.fecha.getTime())
    return { clave, paquete: { ...paquete, lugares } }
  })
  paquetes.sort((a, b) => Number(b.clave === texto) - Number(a.clave === texto) || ultimaFecha(b.paquete) - ultimaFecha(a.paquete))

  return {
    paquetes: paquetes.slice(0, LIMITE_PAQUETES).map(({ paquete }) => paquete),
    hayMas: recepciones.hayMas || entregas.hayMas || reasignaciones.hayMas || odoo.hayMas || paquetes.length > LIMITE_PAQUETES,
    odooFallo: odoo.fallo,
  }
}
