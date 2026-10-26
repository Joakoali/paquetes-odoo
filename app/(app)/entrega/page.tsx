import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Almacen } from '@/db/schema'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { listarBarcosParaEntregar, listarEntregadasHoy, type BarcoParaEntregar, type EntregaDeHoy } from '@/lib/entrega/entregas'
import { ErrorParaOperario } from '@/lib/errores'
import { textoDePaquetes } from '@/lib/ui/cola-escaneo'
import { mensajeDeLecturaFallida } from '@/lib/ui/lectura-fallida'
import { ListaBarcos } from './ListaBarcos'

/**
 * The barcos with something to deliver, or what to tell the operario when they could not be read. Only a reading that
 * failed is told: a bug goes on to the error screen of the app.
 */
async function leerBarcos(almacen: Almacen): Promise<{ barcos: BarcoParaEntregar[] } | { mensaje: string }> {
  try {
    return { barcos: await listarBarcosParaEntregar(almacen) }
  } catch (error) {
    const mensaje = mensajeDeLecturaFallida(error)
    if (mensaje === null) throw error
    return { mensaje }
  }
}

/** How the sync of an entrega that was confirmed is going. A problem is where the operario goes to see what it is: Pendientes. */
function EstadoDeEntrega({ estado }: { estado: EntregaDeHoy['estado'] }) {
  if (estado === 'enviando') return <span className="estado-enviando">enviando…</span>
  if (estado === 'ok') {
    return (
      <span className="estado-ok">
        <span aria-hidden="true">✓ </span>en Odoo
      </span>
    )
  }
  return (
    <Link href="/pendientes" className="estado-problema">
      <span aria-hidden="true">⚠ </span>problema
    </Link>
  )
}

/** The entregas confirmed today in the almacén, with who received them. Not touched, except for "problema". */
function EntregadasHoy({ entregadas }: { entregadas: EntregaDeHoy[] }) {
  return (
    <section className="inicio-seccion" aria-labelledby="entregadas-rotulo">
      <h2 className="label" id="entregadas-rotulo">Entregadas hoy</h2>
      {entregadas.length === 0 ? (
        <p className="lista-vacia">Todavía no se entregó nada hoy.</p>
      ) : (
        <ul className="list">
          {entregadas.map((entrega) => (
            <li key={entrega.id} className="enviada">
              <span className="fila-texto">
                <span className="fila-nombre">{entrega.barcoNombre}</span>
                <span className="fila-meta">
                  {[textoDePaquetes(entrega.paquetes), entrega.receptorNombre ? `recibió ${entrega.receptorNombre}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <EstadoDeEntrega estado={entrega.estado} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Step 1 of the delivery, on the phone: the barcos that have packages waiting in the almacén the operario is working in
 * (a live reading of Odoo) and what was delivered today. Without Odoo the list says why it is not there, with a way to
 * read again, and what was delivered today is still shown: it does not come from Odoo.
 */
export default async function EntregaPage() {
  // The layout sends whoever has no valid session to the login, but it does not render again when the operario
  // moves from one tab to another: this is the check that does when the session expired meanwhile.
  const operario = await requireOperarioFromCookies().catch(() => redirect('/login'))

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

  const [lectura, entregadas] = await Promise.all([leerBarcos(almacen), listarEntregadasHoy(almacen.id)])

  // `ahora` is read here and handed down: the list is also drawn in the browser, and each clock would say a different time.
  return (
    <main className="page">
      {'mensaje' in lectura ? (
        <>
          <p className="banner banner-error" role="alert">{lectura.mensaje}</p>
          <div className="actions">
            <Link href="/entrega" className="btn btn-secondary">Reintentar</Link>
          </div>
        </>
      ) : (
        <ListaBarcos barcos={lectura.barcos} almacenPrefijo={almacen.prefijo} ahora={new Date()} />
      )}

      <EntregadasHoy entregadas={entregadas} />
    </main>
  )
}
