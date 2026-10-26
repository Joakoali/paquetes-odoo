import { ErrorParaOperario } from '../errores'
// Type only: lib/odoo/pickings.ts reaches Odoo.
import type { LineaEntrega } from '../odoo/pickings'

/*
 * What the delivery screen offers and what the server accepts of the lines a phone says it is delivering. The phone sends
 * ids and the ids are not to be trusted: an entrega is only made of lines Odoo itself has waiting for the barco in the
 * almacén, and that no other entrega is already delivering.
 */

/** A line asked for that Odoo does not list as waiting for this barco in this almacén: another almacén's, another barco's, or already delivered. */
export const PAQUETES_YA_NO_PENDIENTES = 'Algunos paquetes ya no están pendientes de entrega. Volvé a abrir el barco.'

/** A line asked for that an entrega still on its way to Odoo has taken: Odoo lists it until the worker validates that entrega. */
export const PAQUETES_EN_ENVIO = 'Algunos paquetes ya están en una entrega que se está enviando a Odoo. Volvé a abrir el barco.'

/**
 * What to offer of the lines Odoo has waiting: those that no entrega on its way to Odoo (`retenidas`) has taken, in their
 * order, and how many of the lines Odoo lists are held, so that the screen can say they are on their way.
 */
export function separarRetenidas(
  pendientes: readonly LineaEntrega[],
  retenidas: ReadonlySet<number>,
): { disponibles: LineaEntrega[]; enviandose: number } {
  const disponibles = pendientes.filter((linea) => !retenidas.has(linea.moveLineId))
  return { disponibles, enviandose: pendientes.length - disponibles.length }
}

/**
 * The lines of `pendientes` that `pedidas` names, in the order `pendientes` has them (that of Odoo), and the deliveries
 * they are on, each once. `pedidas` is what the phone sent, so it can be anything: one id that is not a line of
 * `pendientes`, or that is one `retenidas` holds, makes the whole request fail, and nothing is partly accepted.
 *
 * It does not say that something has to be asked for: an empty request gives an empty answer, and it is for the caller
 * to tell the operario that there is nothing to deliver.
 */
export function resolverElegidas(entrada: {
  pedidas: unknown
  pendientes: readonly LineaEntrega[]
  retenidas: ReadonlySet<number>
}): { moveLineIds: number[]; pickingIds: number[] } {
  const { pedidas, pendientes, retenidas } = entrada
  if (!Array.isArray(pedidas)) throw new ErrorParaOperario(PAQUETES_YA_NO_PENDIENTES)

  const quePendientes = new Set(pendientes.map((linea) => linea.moveLineId))
  if (pedidas.some((id) => !quePendientes.has(id))) throw new ErrorParaOperario(PAQUETES_YA_NO_PENDIENTES)
  if (pedidas.some((id) => retenidas.has(id))) throw new ErrorParaOperario(PAQUETES_EN_ENVIO)

  const pedidasSet = new Set<unknown>(pedidas)
  const elegidas = pendientes.filter((linea) => pedidasSet.has(linea.moveLineId))
  return {
    moveLineIds: elegidas.map((linea) => linea.moveLineId),
    pickingIds: [...new Set(elegidas.map((linea) => linea.pickingId))],
  }
}
