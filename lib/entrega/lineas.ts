import { ErrorParaOperario } from '../errores'
// Type only: lib/odoo/pickings.ts reaches Odoo.
import type { LineaEntrega } from '../odoo/pickings'

/*
 * What the server accepts of the lines a phone says it is delivering. The phone sends ids and the ids are not to be
 * trusted: an entrega is only made of lines Odoo itself has waiting for the barco in the almacén.
 */

/** A line asked for that Odoo does not list as waiting for this barco in this almacén: another almacén's, another barco's, or already delivered. */
export const PAQUETES_YA_NO_PENDIENTES = 'Algunos paquetes ya no están pendientes de entrega. Volvé a abrir el barco.'

/**
 * The lines of `pendientes` that `pedidas` names, in the order `pendientes` has them (that of Odoo), and the deliveries
 * they are on, each once. `pedidas` is what the phone sent, so it can be anything: one id that is not a line of
 * `pendientes` makes the whole request fail, and nothing is partly accepted.
 *
 * It does not say that something has to be asked for: an empty request gives an empty answer, and it is for the caller
 * to tell the operario that there is nothing to deliver.
 */
export function resolverElegidas(entrada: {
  pedidas: unknown
  pendientes: readonly LineaEntrega[]
}): { moveLineIds: number[]; pickingIds: number[] } {
  const { pedidas, pendientes } = entrada
  if (!Array.isArray(pedidas)) throw new ErrorParaOperario(PAQUETES_YA_NO_PENDIENTES)

  const quePendientes = new Set(pendientes.map((linea) => linea.moveLineId))
  if (pedidas.some((id) => !quePendientes.has(id))) throw new ErrorParaOperario(PAQUETES_YA_NO_PENDIENTES)

  const pedidasSet = new Set<unknown>(pedidas)
  const elegidas = pendientes.filter((linea) => pedidasSet.has(linea.moveLineId))
  return {
    moveLineIds: elegidas.map((linea) => linea.moveLineId),
    pickingIds: [...new Set(elegidas.map((linea) => linea.pickingId))],
  }
}
