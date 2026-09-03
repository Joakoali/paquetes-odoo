import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { listSessionsInError, listSessionsWithDuplicates } from '@/lib/sync/pendientes'
import { retrySessionAction } from './actions'

export default async function PendientesPage() {
  await requireOperarioFromCookies()
  const [enError, conDuplicados] = await Promise.all([
    listSessionsInError(),
    listSessionsWithDuplicates(),
  ])

  return (
    <main>
      <h1>Pendientes de atención</h1>

      <h2>Errores de sincronización</h2>
      {enError.length === 0 ? <p>Ninguna.</p> : (
        <ul>
          {enError.map((s) => (
            <li key={s.id}>
              Sesión {s.id} — intentos: {s.intentos} — error: {s.ultimoError}
              <form action={retrySessionAction.bind(null, s.id)}>
                <button type="submit">Reintentar</button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <h2>Sincronizadas con duplicados detectados</h2>
      {conDuplicados.length === 0 ? <p>Ninguna.</p> : (
        <ul>
          {conDuplicados.map((s) => (
            <li key={s.id}>
              Sesión {s.id} — {s.ultimoError ?? 'algún tracking number ya existía en Odoo y quedó fuera del picking'}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
