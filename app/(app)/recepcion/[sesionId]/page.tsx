import { notFound, redirect } from 'next/navigation'
import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { getCouriersParaRecepcion } from '@/lib/recepcion/couriers'
import { getRecepcion, type RecepcionDetalle } from '@/lib/recepcion/recepciones'
import { textoDeDuplicado } from '@/lib/ui/respuesta-escaneo'
import { CabeceraDeBarco } from './CabeceraDeBarco'
import { RecepcionBarco } from './RecepcionBarco'

/** A recepción that was already sent: what it had, to be read. Nothing can be done to it from here. */
function SoloLectura({ recepcion }: { recepcion: RecepcionDetalle }) {
  return (
    <>
      <CabeceraDeBarco barcoNombre={recepcion.barcoNombre} almacenPrefijo={recepcion.almacenPrefijo} />

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

  // The same answer for a recepción that does not exist and for one the operario may not see. Only an operario who
  // has its almacén may open it, the admin included: that is what the actions ask of everybody (`exigirAlmacen`), as
  // `getAlmacenActivo` does, so an admin without the almacén would be given a screen on which every button answers
  // "No tenés acceso a esto.". It also keeps the screen from showing what is in somebody else's almacén to whoever
  // has its address.
  const recepcion = await getRecepcion(sesionId)
  if (recepcion === null || !(await operarioHasAlmacen(operario.id, recepcion.almacenId))) notFound()

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
