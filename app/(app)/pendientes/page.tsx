import { redirect } from 'next/navigation'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { haceCuanto } from '@/lib/fechas'
import { textoDePaquetes } from '@/lib/ui/cola-escaneo'
import { alcanceDelOperario, listarProblemas, type Problema, type TipoProblema } from '@/lib/sync/pendientes'
import { marcarRevisadoAction, reintentarAction } from './actions'
import { AccionProblema } from './AccionProblema'

const TITULOS: Record<TipoProblema, string> = {
  error: 'No se pudo enviar a Odoo',
  trabado: 'Envío trabado',
  duplicado: 'Paquete que no entró por duplicado',
}

const SESIONES: Record<Problema['sesionTipo'], string> = {
  recepcion: 'Recepción',
  entrega: 'Entrega',
}

function Tarjeta({ problema, ahora }: { problema: Problema; ahora: Date }) {
  const { sesionId, tipo } = problema
  const quienYCuando = [
    SESIONES[problema.sesionTipo], problema.almacenPrefijo, problema.operarioNombre, haceCuanto(problema.fecha, ahora),
  ].join(' · ')

  return (
    <li className="card">
      <p>
        <span className="badge">{TITULOS[tipo]}</span>
        {problema.loArreglaElAdmin ? <span className="badge">Lo tiene que arreglar el admin</span> : null}
      </p>
      <h2>{problema.barcoNombre}</h2>
      <p>{quienYCuando}</p>
      {problema.entrega ? (
        // An entrega has no tracking numbers to list: it says how many packages it covers and who received them.
        <p>
          {[textoDePaquetes(problema.entrega.paquetes), problema.entrega.receptorNombre ? `recibió ${problema.entrega.receptorNombre}` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}

      <p>{problema.mensaje}</p>
      {problema.paquetes.length > 0 ? (
        <ul>
          {problema.paquetes.map((paquete, posicion) => (
            <li key={`${posicion}-${paquete.trackingNumber}`}>
              <span className="mono">{paquete.trackingNumber}</span>
              {paquete.ref ? <> · ya estaba en <span className="mono">{paquete.ref}</span></> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="actions">
        {/* A failed or a stuck send is solved by retrying it; only a duplicado is reviewed (spec 5.4). */}
        {tipo === 'duplicado' ? (
          <AccionProblema accion={marcarRevisadoAction} sesionId={sesionId} className="btn btn-secondary">
            Marcar como revisado
          </AccionProblema>
        ) : (
          <AccionProblema accion={reintentarAction} sesionId={sesionId} className="btn btn-primary">
            Reintentar
          </AccionProblema>
        )}
      </div>

      {problema.detalle ? (
        <details>
          <summary>Ver detalle</summary>
          <p className="mono">{problema.detalle}</p>
        </details>
      ) : null}
    </li>
  )
}

export default async function PendientesPage() {
  // The layout sends whoever has no valid session to the login, but it does not render again when the operario
  // moves from one tab to another: this is the check that does when the session expired meanwhile.
  const operario = await requireOperarioFromCookies().catch(() => redirect('/login'))
  const ahora = new Date()
  const problemas = await listarProblemas(await alcanceDelOperario(operario), ahora)

  return (
    <main className="page">
      <h1>Pendientes</h1>
      {problemas.length === 0 ? (
        <p>No hay nada pendiente.</p>
      ) : (
        <ul>
          {problemas.map((problema) => (
            <Tarjeta key={problema.sesionId} problema={problema} ahora={ahora} />
          ))}
        </ul>
      )}
    </main>
  )
}
