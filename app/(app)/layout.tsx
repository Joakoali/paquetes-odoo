import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { NavBar, type NavLink } from '@/components/nav-bar'

// proxy.ts already bounces cookie-less requests to /login; this catch covers the
// expired / tampered-cookie case so the shell redirects instead of 500ing.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const operario = await requireOperarioFromCookies().catch(() => redirect('/login'))

  const links: NavLink[] = [
    { href: '/recepcion', label: 'Recepción' },
    { href: '/entrega', label: 'Entrega' },
    { href: '/pendientes', label: 'Pendientes' },
  ]
  if (operario.rol === 'admin') links.push({ href: '/admin', label: 'Admin' })

  return (
    <>
      <NavBar links={links} operarioNombre={operario.nombre} />
      {children}
    </>
  )
}
