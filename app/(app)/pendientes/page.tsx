import { listSessionsInError } from '@/lib/sync/pendientes'
import { retrySessionAction } from './actions'

export default async function PendientesPage() {
  const sesiones = await listSessionsInError()
  return (
    <main>
      <h1>Pendientes de atención</h1>
      <ul>
        {sesiones.map((s) => (
          <li key={s.id}>
            Sesión {s.id} — intentos: {s.intentos} — error: {s.ultimoError}
            <form action={retrySessionAction.bind(null, s.id)}>
              <button type="submit">Reintentar</button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  )
}
