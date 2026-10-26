import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import type { Operario } from '@/db/schema'
import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { getCouriersParaRecepcion } from '@/lib/recepcion/couriers'
import { getRecepcion, type RecepcionDetalle } from '@/lib/recepcion/recepciones'
import { textoDeDuplicado } from '@/lib/ui/respuesta-escaneo'
import { RecepcionBarco } from './RecepcionBarco'

/**
 * The admin may open any recepción. An operario only those of an almacén they have: the actions check it for
 * what is done on the screen, and this is what keeps the screen itself from showing what is in somebody else's
 * almacén to whoever has its address.
 */
async function puedeVer(operario: Pick<Operario, 'id' | 'rol'>, almacenId: number): Promise<boolean> {
  return operario.rol === 'admin' || (await operarioHasAlmacen(operario.id, almacenId))
}

/** A recepción that was already sent: what it had, to be read. Nothing can be done to it from here. */
function SoloLectura({ recepcion }: { recepcion: RecepcionDetalle }) {
  return (
    <>
      <header className="barco-cabecera">
        <Link href="/recepcion" className="btn-link">‹ Recepciones</Link>
        <h1 className="barco-nombre">{recepcion.barcoNombre}</h1>
      </header>

      <p className="banner">Esta recepción ya se envió.</p>

      {recepcion.paquetes.length > 0 ? (
        <ul className="list paquetes-lista">
          {recepcion.paquetes.map((paquete) => (
            <li key={paquete.id} className={`paquete paquete-${paquete.estado}`}>
              <span className="mono paquete-codigo">
                {paquete.estado === 'duplicado' ? <span aria-hidden="true">⚠ </span> : null}
                {paquete.trackingNumber}
              </span>
              <span className="badge">{paquete.courierNombre}</span>
              {paquete.estado === 'duplicado' ? (
                <span className="paquete-estado">{textoDeDuplicado(paquete.duplicadoRef)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

export default async function RecepcionBarcoPage({ params }: { params: Promise<{ sesionId: string }> }) {
  // The layout sends whoever has no valid session to the login, but it does not render again when the operario
  // moves from one tab to another: this is the check that does when the session expired meanwhile.
  const operario = await requireOperarioFromCookies().catch(() => redirect('/login'))
  const { sesionId } = await params

  // The same answer for a recepción that does not exist and for one the operario may not see.
  const recepcion = await getRecepcion(sesionId)
  if (recepcion === null || !(await puedeVer(operario, recepcion.almacenId))) notFound()

  if (recepcion.estado !== 'en_curso') {
    return (
      <main className="page">
        <SoloLectura recepcion={recepcion} />
      </main>
    )
  }

  const couriers = await getCouriersParaRecepcion(recepcion.almacenId)
  return (
    <main className="page">
      <RecepcionBarco key={recepcion.id} recepcion={recepcion} couriers={couriers} />
    </main>
  )
}
