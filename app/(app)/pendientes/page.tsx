import { redirect } from 'next/navigation'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { haceCuanto } from '@/lib/fechas'
import { alcanceDelOperario, listarProblemas, type Problema, type TipoProblema } from '@/lib/sync/pendientes'
import { marcarRevisadoAction, reintentarAction } from './actions'

const TITULOS: Record<TipoProblema, string> = {
  error: 'No se pudo enviar a Odoo',
  trabado: 'Envío trabado',
  duplicado: 'Paquete que no entró por duplicado',
}

const SESIONES: Record<Problema['sesionTipo'], string> = {
  recepcion: 'Recepción',
  entrega: 'Entrega',
}

/**
 * `<form action>` takes a function that answers nothing, and the actions answer a `ResultadoAccion`, which only
 * a client component could show. These two are what the forms call: they run the action and let the answer go.
 */
async function reintentarDesdeFormulario(sesionId: string): Promise<void> {
  'use server'
  await reintentarAction(sesionId)
}

async function marcarRevisadoDesdeFormulario(sesionId: string): Promise<void> {
  'use server'
  await marcarRevisadoAction(sesionId)
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

      <div>
        {tipo === 'duplicado' ? null : (
          <form action={reintentarDesdeFormulario.bind(null, sesionId)}>
            <button type="submit" className="btn btn-primary">Reintentar</button>
          </form>
        )}
        <form action={marcarRevisadoDesdeFormulario.bind(null, sesionId)}>
          <button type="submit" className="btn btn-secondary">Marcar como revisado</button>
        </form>
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
