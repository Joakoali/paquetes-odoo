import Link from 'next/link'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { refreshBarcosAction } from './actions'

export default async function AdminHomePage() {
  await requireAdminFromCookies()

  return (
    <main>
      <h1>Administración</h1>

      <ul>
        <li><Link href="/admin/operarios" style={{ textDecoration: 'underline' }}>Operarios</Link></li>
        <li><Link href="/admin/mapeos" style={{ textDecoration: 'underline' }}>Mapeos con Odoo</Link></li>
      </ul>

      <h2>Mantenimiento</h2>
      <form action={refreshBarcosAction}>
        <button type="submit">Refrescar barcos ahora</button>
      </form>
      <p style={{ opacity: 0.7, maxWidth: 480 }}>
        Encola un refresh del cache de barcos desde Odoo (por la cola <code>odoo-sync</code>).
        El cron lo corre igual todos los días a las 06:00 UTC.
      </p>
    </main>
  )
}
