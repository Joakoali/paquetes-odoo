import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { AppShell, type Tab } from '@/components/app-shell'
import type { Operario } from '@/db/schema'
import { getAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { alcanceDelOperario, contarProblemas } from '@/lib/sync/pendientes'

/**
 * The number on the Pendientes tab. It is a help, not a reason to take the whole app down: if it cannot be counted
 * the tab shows no number, and the screen that is open says what is wrong with the database if it is.
 */
async function contarPendientes(operario: Pick<Operario, 'id' | 'rol'>): Promise<number | undefined> {
  try {
    return await contarProblemas(await alcanceDelOperario(operario))
  } catch (err) {
    console.error('No se pudieron contar los pendientes', err)
    return undefined
  }
}

// proxy.ts already bounces cookie-less requests to /login; this catch covers the
// expired / tampered-cookie case so the shell redirects instead of 500ing.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const operario = await requireOperarioFromCookies().catch(() => redirect('/login'))

  const [almacenes, pendientes] = await Promise.all([getAlmacenActivo(operario.id), contarPendientes(operario)])

  const tabs: Tab[] = [
    { href: '/recepcion', label: 'Recepción' },
    { href: '/entrega', label: 'Entrega' },
    { href: '/pendientes', label: 'Pendientes', badge: pendientes },
  ]
  if (operario.rol === 'admin') tabs.push({ href: '/admin', label: 'Admin' })

  return (
    <AppShell tabs={tabs} almacenes={almacenes} operarioNombre={operario.nombre}>
      {children}
    </AppShell>
  )
}
