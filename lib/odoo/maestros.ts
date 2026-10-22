import { formatFechaOdoo } from '../fechas'
import { odooCall } from './client'

/** A Many2one as `search_read` returns it: `[id, displayName]`, or `false` when it is empty. */
type Many2one = [number, string] | false

interface WarehouseRead {
  id: number
  code: string
  name: string
  in_type_id: Many2one
  out_type_id: Many2one
}

interface ProductRead {
  id: number
  name: string
}

interface MoveLineRead {
  product_id: Many2one
  picking_type_id: Many2one
}

interface ProjectRead {
  id: number
  name: string
}

export interface AlmacenOdoo {
  warehouseId: number
  codigo: string
  nombre: string
  /** Operation type of the receptions. */
  inTypeId: number
  /** Operation type of the deliveries. */
  outTypeId: number
}

export interface CourierOdoo {
  productId: number
  nombre: string
}

/** How many packages of a courier were received through a reception type. */
export interface UsoCourierOdoo {
  inTypeId: number
  productId: number
  usos: number
}

export interface BarcoOdoo {
  odooId: number
  nombre: string
}

/** The warehouses, with the reception and delivery operation type of each. */
export async function fetchAlmacenes(): Promise<AlmacenOdoo[]> {
  const warehouses = await odooCall<WarehouseRead[]>('stock.warehouse', 'search_read', {
    domain: [],
    fields: ['code', 'name', 'in_type_id', 'out_type_id'],
  })
  // Without both types the app can neither receive nor deliver there, so it is not an almacén.
  return warehouses.flatMap((w) => (w.in_type_id && w.out_type_id
    ? [{ warehouseId: w.id, codigo: w.code, nombre: w.name, inTypeId: w.in_type_id[0], outTypeId: w.out_type_id[0] }]
    : []))
}

/** Couriers are the products tracked by serial number: each package is a serial number. */
export async function fetchCouriers(): Promise<CourierOdoo[]> {
  const products = await odooCall<ProductRead[]>('product.product', 'search_read', {
    domain: [['tracking', '=', 'serial']],
    fields: ['name'],
  })
  return products.map((p) => ({ productId: p.id, nombre: p.name }))
}

/**
 * How many packages of each courier came in through each reception type since `desde`.
 * A done move line is one package (one serial number), so it is counted here and not
 * in Odoo: `search_read` has no group-by.
 */
export async function fetchUsoCouriers(desde: Date): Promise<UsoCourierOdoo[]> {
  const lineas = await odooCall<MoveLineRead[]>('stock.move.line', 'search_read', {
    domain: [
      ['picking_code', '=', 'incoming'],
      ['state', '=', 'done'],
      ['date', '>=', formatFechaOdoo(desde)],
    ],
    fields: ['product_id', 'picking_type_id'],
  })

  const usos = new Map<string, UsoCourierOdoo>()
  for (const linea of lineas) {
    if (!linea.product_id || !linea.picking_type_id) continue
    const inTypeId = linea.picking_type_id[0]
    const productId = linea.product_id[0]
    const clave = `${inTypeId}:${productId}`
    const uso = usos.get(clave)
    if (uso) uso.usos += 1
    else usos.set(clave, { inTypeId, productId, usos: 1 })
  }
  return [...usos.values()]
}

/** Barcos are the projects. */
export async function fetchBarcos(): Promise<BarcoOdoo[]> {
  const projects = await odooCall<ProjectRead[]>('project.project', 'search_read', {
    domain: [],
    fields: ['name'],
  })
  return projects.map((p) => ({ odooId: p.id, nombre: p.name }))
}
