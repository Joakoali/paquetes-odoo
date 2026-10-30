import type { PaqueteDeOdoo } from '../../db/schema'
import { ErrorParaOperario } from '../errores'
// Type only: lib/odoo/pickings.ts reaches Odoo.
import type { LineaEntrega } from '../odoo/pickings'

/*
 * What the delivery screen offers and what the server accepts of the lines a phone says it is delivering or moving to
 * another barco. The phone sends ids and the ids are not to be trusted: an entrega or a reasignación is only made of lines
 * Odoo itself has waiting for the barco in the almacén, and that no other entrega or reasignación is already taking.
 */

/** A line asked for that Odoo does not list as waiting for this barco in this almacén: another almacén's, another barco's, or already delivered. */
export const PAQUETES_YA_NO_PENDIENTES = 'Algunos paquetes ya no están pendientes de entrega. Volvé a abrir el barco.'

/** A line asked for that an entrega still on its way to Odoo has taken: Odoo lists it until the worker validates that entrega. */
export const PAQUETES_EN_ENVIO = 'Algunos paquetes ya están en una entrega que se está enviando a Odoo. Volvé a abrir el barco.'

/** A line asked for that a reasignación still on its way to Odoo is moving: Odoo lists it on this barco until the worker moves it. */
export const PAQUETES_MOVIENDOSE = 'Algunos paquetes ya se están pasando a otro barco. Volvé a abrir el barco.'

/**
 * Why a line Odoo lists as waiting for the barco is taken: an entrega on its way to Odoo hands it over, or a reasignación
 * on its way moves it to the barco `barcoOdooId`, which the screen calls `barcoNombre` (its name, with its id when another
 * barco the packages go to has the same name).
 */
export type Retencion = { tipo: 'entrega' } | { tipo: 'reasignacion'; barcoOdooId: number; barcoNombre: string }

/**
 * What the entregas and reasignaciones on their way to Odoo have taken of a barco: by line and by package. Odoo can make a
 * line again under another id before the worker gets to it (the backorder of an entrega that validated the delivery the
 * line was on), and its package is still taken.
 */
export interface Retenidas {
  porLinea: ReadonlyMap<number, Retencion>
  porNumero: ReadonlyMap<string, Retencion>
}

/** Nothing taken. */
export const NADA_RETENIDO: Retenidas = { porLinea: new Map(), porNumero: new Map() }

/** Why the line is taken, by its id or by its package; undefined when it is not. A line without number goes by its id alone. */
export function retencionDe(retenidas: Retenidas, linea: Pick<LineaEntrega, 'moveLineId' | 'trackingNumber'>): Retencion | undefined {
  return retenidas.porLinea.get(linea.moveLineId)
    ?? (linea.trackingNumber === null ? undefined : retenidas.porNumero.get(linea.trackingNumber))
}

/** The packages a reasignación on its way to Odoo takes to a barco: what the screen says of them, barco by barco. */
export interface Moviendose {
  barcoOdooId: number
  barcoNombre: string
  paquetes: number
}

/**
 * What to offer of the lines Odoo has waiting: those that no entrega or reasignación on its way to Odoo (`retenidas`) has
 * taken, in their order. And, of the lines Odoo lists that are held, how many are being handed over and how many go to
 * each other barco (by its id: two barcos can have the same name), in the order of their first line, so that the screen
 * can say they are on their way.
 */
export function separarRetenidas(
  pendientes: readonly LineaEntrega[],
  retenidas: Retenidas,
): { disponibles: LineaEntrega[]; enviandose: number; moviendose: Moviendose[] } {
  const disponibles: LineaEntrega[] = []
  let enviandose = 0
  const porBarco = new Map<number, Moviendose>()
  for (const linea of pendientes) {
    const retencion = retencionDe(retenidas, linea)
    if (!retencion) disponibles.push(linea)
    else if (retencion.tipo === 'entrega') enviandose += 1
    else {
      const { barcoOdooId, barcoNombre } = retencion
      const destino = porBarco.get(barcoOdooId) ?? { barcoOdooId, barcoNombre, paquetes: 0 }
      destino.paquetes += 1
      porBarco.set(barcoOdooId, destino)
    }
  }
  return { disponibles, enviandose, moviendose: [...porBarco.values()] }
}

/**
 * The lines of `pendientes` that `pedidas` names, in the order `pendientes` has them (that of Odoo), the deliveries they
 * are on, each once, and what each of those lines is (its package, courier and delivery), which the entrega or the
 * reasignación keeps. `pedidas` is what the phone sent, so it can be anything: one id that is not a line of `pendientes`,
 * or that is one `retenidas` holds, makes the whole request fail, and nothing is partly accepted.
 *
 * It does not say that something has to be asked for: an empty request gives an empty answer, and it is for the caller
 * to tell the operario that there is nothing to deliver or to move.
 */
export function resolverElegidas(entrada: {
  pedidas: unknown
  pendientes: readonly LineaEntrega[]
  retenidas: Retenidas
}): { moveLineIds: number[]; pickingIds: number[]; paquetes: PaqueteDeOdoo[] } {
  const { pedidas, pendientes, retenidas } = entrada
  if (!Array.isArray(pedidas)) throw new ErrorParaOperario(PAQUETES_YA_NO_PENDIENTES)

  const quePendientes = new Set(pendientes.map((linea) => linea.moveLineId))
  if (pedidas.some((id) => !quePendientes.has(id))) throw new ErrorParaOperario(PAQUETES_YA_NO_PENDIENTES)

  const pedidasSet = new Set<unknown>(pedidas)
  const elegidas = pendientes.filter((linea) => pedidasSet.has(linea.moveLineId))
  const tomadas = elegidas.flatMap((linea) => retencionDe(retenidas, linea) ?? [])
  if (tomadas.some((retencion) => retencion.tipo === 'entrega')) throw new ErrorParaOperario(PAQUETES_EN_ENVIO)
  if (tomadas.length > 0) throw new ErrorParaOperario(PAQUETES_MOVIENDOSE)

  return {
    moveLineIds: elegidas.map((linea) => linea.moveLineId),
    pickingIds: [...new Set(elegidas.map((linea) => linea.pickingId))],
    paquetes: elegidas.map(({ trackingNumber, courierNombre, pickingRef }) => ({ trackingNumber, courierNombre, pickingRef })),
  }
}
