import { and, asc, eq, ilike, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { barcosCache } from '../../db/schema'

export const BUSQUEDA_BARCOS_LIMITE = 20

export interface BarcoOpcion {
  odooId: number
  nombre: string
  /**
   * What the picker shows: the name, followed by the Odoo id when another barco in the
   * same result has the same name (there can be several "H3"), so they can be told apart.
   */
  etiqueta: string
}

/** What the operator types is literal text: `%` and `_` are not wildcards, and `\` is LIKE's escape character. */
function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, '\\$&')
}

/** Active barcos whose name contains `query`, by name, at most BUSQUEDA_BARCOS_LIMITE. */
export async function searchBarcos(query: string): Promise<BarcoOpcion[]> {
  const filas = await db.select({ odooId: barcosCache.odooId, nombre: barcosCache.nombre })
    .from(barcosCache)
    .where(and(eq(barcosCache.activo, true), ilike(barcosCache.nombre, `%${escaparLike(query)}%`)))
    // Without lower() the C collation sorts every capital before any lowercase letter.
    // The id is the last tie-break so two barcos with the same name always come in the same order.
    .orderBy(asc(sql`lower(${barcosCache.nombre})`), asc(barcosCache.nombre), asc(barcosCache.odooId))
    .limit(BUSQUEDA_BARCOS_LIMITE)

  const repeticiones = new Map<string, number>()
  for (const { nombre } of filas) {
    const clave = nombre.toLowerCase()
    repeticiones.set(clave, (repeticiones.get(clave) ?? 0) + 1)
  }
  return filas.map(({ odooId, nombre }) => ({
    odooId,
    nombre,
    etiqueta: (repeticiones.get(nombre.toLowerCase()) ?? 0) > 1 ? `${nombre} · #${odooId}` : nombre,
  }))
}
