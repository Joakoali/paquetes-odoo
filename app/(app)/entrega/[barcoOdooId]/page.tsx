import { eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { db } from '@/db/client'
import { barcosCache, type Almacen } from '@/db/schema'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { moveLineIdsRetenidas } from '@/lib/entrega/entregas'
import { separarRetenidas } from '@/lib/entrega/lineas'
import { ConfiguracionError, ErrorParaOperario } from '@/lib/errores'
import { getLineasEntregaPendiente, type LineaEntrega } from '@/lib/odoo/pickings'
import { contarSinEnviarPorBarco } from '@/lib/recepcion/recepciones'
import { mensajeDeLecturaFallida } from '@/lib/ui/lectura-fallida'
import { EntregaFlow } from './EntregaFlow'

/** The biggest id the `integer` column of the cache holds: a barco with a bigger one cannot exist. */
const ID_MAXIMO = 2_147_483_647

/** The id of the barco in the address, or null when what is there is not one. */
function idDeLaDireccion(texto: string): number | null {
  if (!/^[1-9]\d*$/.test(texto)) return null
  const id = Number(texto)
  return id <= ID_MAXIMO ? id : null
}

/**
 * What Odoo has waiting for the barco in the almacén and no entrega on its way to Odoo has taken, how many of its packages
 * are taken like that, and how many are received and not sent, or what to tell the operario when they could not be read. Only a reading that failed is told: a bug goes on to the error screen
 * of the app.
 */
async function leerEntrega(
  almacen: Almacen,
  barcoOdooId: number,
): Promise<{ lineas: LineaEntrega[]; enviandose: number; sinEnviar: number } | { mensaje: string }> {
  try {
    if (!almacen.odooOutTypeId) {
      throw new ConfiguracionError('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')
    }
    const [pendientes, sinEnviar, retenidas] = await Promise.all([
      getLineasEntregaPendiente({ outTypeId: almacen.odooOutTypeId, barcoOdooId }),
      contarSinEnviarPorBarco(almacen.id),
      moveLineIdsRetenidas({ almacenId: almacen.id, barcoOdooId }),
    ])
    // Odoo goes on listing the packages of an entrega until the worker validates it, about a minute after it was confirmed:
    // they are not offered again meanwhile, or a second entrega of them would be one tap away.
    const { disponibles, enviandose } = separarRetenidas(pendientes, retenidas)
    return { lineas: disponibles, enviandose, sinEnviar: sinEnviar.get(barcoOdooId) ?? 0 }
  } catch (error) {
    const mensaje = mensajeDeLecturaFallida(error)
    if (mensaje === null) throw error
    return { mensaje }
  }
}

/**
 * Steps 2 and 3 of the delivery, on the phone: the packages Odoo has waiting for the barco in the almacén the operario is
 * working in (a live reading of Odoo), the choice of which to hand over, and the name and signature of the crew. The name
 * of the barco is the one of the cache, with no call to Odoo.
 */
export default async function EntregaBarcoPage({ params }: { params: Promise<{ barcoOdooId: string }> }) {
  // The layout sends whoever has no valid session to the login, but it does not render again when the operario
  // moves from one tab to another: this is the check that does when the session expired meanwhile.
  const operario = await requireOperarioFromCookies().catch(() => redirect('/login'))
  const barcoOdooId = idDeLaDireccion((await params).barcoOdooId)
  if (barcoOdooId === null) notFound()

  let almacen: Almacen
  try {
    almacen = await requireAlmacenActivo(operario.id)
  } catch (error) {
    // An operario with no almacén gets told so. Any other failure is not for them to read: it goes to the error page.
    if (error instanceof ErrorParaOperario) {
      return (
        <main className="page">
          <p className="banner banner-warn">{error.message}</p>
        </main>
      )
    }
    throw error
  }

  // Not only the active barcos: one that is gone from Odoo's list of projects may still have deliveries waiting.
  const barco = await db.query.barcosCache.findFirst({ columns: { nombre: true }, where: eq(barcosCache.odooId, barcoOdooId) })
  if (!barco) notFound()

  const lectura = await leerEntrega(almacen, barcoOdooId)
  if ('mensaje' in lectura) {
    return (
      <main className="page">
        <header className="barco-cabecera">
          <Link href="/entrega" className="btn-link">‹ Entrega</Link>
          <h1 className="barco-nombre">{barco.nombre}</h1>
          <span className="barco-almacen">{almacen.prefijo}</span>
        </header>

        <p className="banner banner-error" role="alert">{lectura.mensaje}</p>
        <div className="actions">
          <Link href={`/entrega/${barcoOdooId}`} className="btn btn-secondary">Reintentar</Link>
        </div>
      </main>
    )
  }

  // The key is the lines it was given: if they change (the packages that were sent come in a minute later), the choice
  // starts again from "all of them", and a line that is new is not left out of it without anybody having said so.
  return (
    // As tall as the screen: the box to sign in takes what is left (see `.entrega-pagina`).
    <main className="page entrega-pagina">
      <EntregaFlow
        key={lectura.lineas.map((linea) => linea.moveLineId).join(',')}
        barcoOdooId={barcoOdooId}
        barcoNombre={barco.nombre}
        almacenPrefijo={almacen.prefijo}
        lineas={lectura.lineas}
        sinEnviar={lectura.sinEnviar}
        enviandose={lectura.enviandose}
      />
    </main>
  )
}
