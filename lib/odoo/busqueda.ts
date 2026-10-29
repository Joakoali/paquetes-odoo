import { parseFechaOdoo } from '../fechas'
import { odooCall } from './client'
import { campoBarco } from './pickings'

/** A Many2one as `search_read` returns it: `[id, displayName]`, or `false` when it is empty. */
type Many2one = [number, string] | false

interface LineaConPaqueteRead {
  lot_id: Many2one
  /** The package of a line that is not validated yet: Odoo makes its lot when it validates. */
  lot_name: string | false
  picking_id: Many2one
  product_id: Many2one
}

/** A picking as the search reads it. Its barco and "Recibido por" are under the keys their env vars name, hence the index signature. */
interface PickingRead {
  id: number
  name: string
  state: string
  picking_type_id: Many2one
  picking_type_code: string | false
  date_done: string | false
  create_date: string
  [campo: string]: unknown
}

/** What a picking is to the search: a reception, a delivery, or anything else (an internal move). */
export type Operacion = 'recepcion' | 'entrega' | 'otra'

/** A line of Odoo whose package has what was searched, with what the search says of the picking it is on. */
export interface LineaEncontradaEnOdoo {
  trackingNumber: string
  /** The product of the line, which is the courier. */
  courierNombre: string | null
  pickingId: number
  /** The name of the picking, e.g. `MB92/IN/00231`. */
  pickingRef: string
  /** The operation type of the picking, which says the almacén. Null when it has none. */
  pickingTypeId: number | null
  operacion: Operacion
  /** Whether the picking is done: received, or delivered. */
  hecho: boolean
  barco: { odooId: number; nombre: string } | null
  /** When the picking was done, or, for one that is not, when it was made. */
  fecha: Date
  /** "Recibido por": the operario on a reception, the crew on a delivery. Null when it is empty or the field is not configured. */
  recibidoPor: string | null
}

const OPERACIONES: Record<string, Operacion> = { incoming: 'recepcion', outgoing: 'entrega' }

/** The line with its package, or null for one with neither lot nor lot name, or in no picking (the domain rules both out). */
function conPaquete(linea: LineaConPaqueteRead): { trackingNumber: string; pickingId: number; courierNombre: string | null } | null {
  const trackingNumber = linea.lot_id ? linea.lot_id[1] : linea.lot_name
  if (!trackingNumber || !linea.picking_id) return null
  return { trackingNumber, pickingId: linea.picking_id[0], courierNombre: linea.product_id ? linea.product_id[1] : null }
}

/**
 * Every line of Odoo that is not cancelled and is on a picking, whose package contains `buscado`, the newest first and at
 * most `limite`, each with what the search says of its picking. The package is the lot of the line or, for a line that is
 * not validated yet, its lot name. Odoo's `ilike` is "contains, whatever the case", as the search of the webapp is, and
 * `buscado` comes without blanks (`textoDeBusqueda`).
 *
 * Two requests, which `odooCall` spaces a second apart: the lines, and their pickings, since a line does not carry the
 * barco (a custom field of the picking). Only the first when no line has the package. It is a read made only when an
 * operario searches, never one per key. "Recibido por" is read when its field is configured, and left out when it is not:
 * the search does not need it to say where a package is.
 */
export async function buscarEnOdoo(entrada: { buscado: string; limite: number }): Promise<LineaEncontradaEnOdoo[]> {
  const barcoField = campoBarco()
  const recibidoPorField = process.env.ODOO_FIELD_RECIBIDO_POR || null

  const lineas = (await odooCall<LineaConPaqueteRead[]>('stock.move.line', 'search_read', {
    domain: [
      ['state', '!=', 'cancel'],
      ['picking_id', '!=', false],
      '|', ['lot_id.name', 'ilike', entrada.buscado], ['lot_name', 'ilike', entrada.buscado],
    ],
    fields: ['lot_id', 'lot_name', 'picking_id', 'product_id'],
    order: 'id desc',
    limit: entrada.limite,
  })).flatMap((linea) => conPaquete(linea) ?? [])
  if (lineas.length === 0) return []

  const pickings = await odooCall<PickingRead[]>('stock.picking', 'read', {
    ids: [...new Set(lineas.map((linea) => linea.pickingId))],
    fields: [
      'name', 'state', 'picking_type_id', 'picking_type_code', 'date_done', 'create_date', barcoField,
      ...(recibidoPorField ? [recibidoPorField] : []),
    ],
  })
  const porId = new Map(pickings.map((picking) => [picking.id, picking]))

  return lineas.flatMap((linea): LineaEncontradaEnOdoo[] => {
    const picking = porId.get(linea.pickingId)
    // A picking that went away between the two reads, or was cancelled with a line that was not.
    if (!picking || picking.state === 'cancel') return []
    const barco = picking[barcoField] as Many2one | undefined
    const recibidoPor = recibidoPorField ? picking[recibidoPorField] : null
    const hecho = picking.state === 'done'
    return [{
      ...linea,
      pickingRef: picking.name,
      pickingTypeId: picking.picking_type_id ? picking.picking_type_id[0] : null,
      operacion: OPERACIONES[picking.picking_type_code || ''] ?? 'otra',
      hecho,
      barco: barco ? { odooId: barco[0], nombre: barco[1] } : null,
      fecha: parseFechaOdoo(hecho && picking.date_done ? picking.date_done : picking.create_date),
      recibidoPor: typeof recibidoPor === 'string' && recibidoPor.trim() !== '' ? recibidoPor : null,
    }]
  })
}
