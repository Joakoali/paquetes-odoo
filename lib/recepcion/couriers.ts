import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { courierUso, couriers } from '../../db/schema'

/** How many couriers are offered as buttons; the rest are behind "Otro courier…". Odoo has 73 of them. */
export const COURIERS_FRECUENTES = 10

/** A courier as the reception screen takes it. Client components may only `import type` this module. */
export interface CourierOpcion {
  id: number
  nombre: string
}

/** Names compare without looking at case or accents ("dhl" next to "DHL", "Ángel" next to "Angel"). */
const porNombre = new Intl.Collator('es', { sensitivity: 'base' })

/**
 * The couriers the reception screen of an almacén offers: only the active ones (an Odoo product that went away
 * is not offered, whatever it was used). `todos` are all of them by name. `frecuentes` are the ten most used in
 * that almacén (`courier_uso`, which the daily refresh fills from Odoo), the most used first; between couriers
 * used the same, and for the ones never used, the order by name decides. So an almacén without usage yet gets
 * the first ten by name, and one with little usage gets what it has used followed by the first by name.
 */
export async function getCouriersParaRecepcion(
  almacenId: number,
): Promise<{ frecuentes: CourierOpcion[]; todos: CourierOpcion[] }> {
  const filas = await db.select({ id: couriers.id, nombre: couriers.nombre, usos: courierUso.usos })
    .from(couriers)
    .leftJoin(courierUso, and(eq(courierUso.courierId, couriers.id), eq(courierUso.almacenId, almacenId)))
    .where(eq(couriers.activo, true))

  // By name here and not in the query: the collation of the database is not the one the operarios read (the
  // id last, so that two couriers with the same name always come in the same order).
  const porOrdenAlfabetico = filas
    .map((fila) => ({ id: fila.id, nombre: fila.nombre, usos: fila.usos ?? 0 }))
    .sort((a, b) => porNombre.compare(a.nombre, b.nombre) || a.id - b.id)
  // The sort is stable: what is used the same stays in the order by name.
  const porUso = [...porOrdenAlfabetico].sort((a, b) => b.usos - a.usos)

  const opcion = ({ id, nombre }: CourierOpcion): CourierOpcion => ({ id, nombre })
  return {
    frecuentes: porUso.slice(0, COURIERS_FRECUENTES).map(opcion),
    todos: porOrdenAlfabetico.map(opcion),
  }
}
