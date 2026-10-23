import { inArray } from 'drizzle-orm'
import { db } from '../../db/client'
import { barcosCache, type Almacen } from '../../db/schema'
import { ConfiguracionError } from '../errores'
import { getBarcosConEntregaPendiente } from '../odoo/pickings'
import { contarSinEnviarPorBarco } from '../recepcion/recepciones'

/** A barco of the delivery list. */
export interface BarcoParaEntregar {
  barcoOdooId: number
  barcoNombre: string
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

  const barcos: BarcoParaEntregar[] = enOdoo.map((barco) => ({ ...barco, sinEnviar: sinEnviar.get(barco.barcoOdooId) ?? 0 }))

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
        // The same placeholder the recepciones use for a barco the cache does not know.
        barcoNombre: nombres.get(barcoOdooId) ?? `Barco #${barcoOdooId}`,
        paquetes: 0,
        desde: null,
        sinEnviar: cantidad,
      })
    }
  }

  return barcos.sort(porAntiguedad)
}
