import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { AppShell, type Tab } from '@/components/app-shell'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'

const TABS: Tab[] = [
  { href: '/recepcion', label: '← Recepción' },
  { href: '/admin/operarios', label: 'Operarios' },
  { href: '/admin', label: 'Datos de Odoo' },
]

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const operario = await requireAdminFromCookies().catch((err) => {
    redirect(err instanceof UnauthorizedError ? '/login' : '/recepcion')
  })

  // No almacén here: nothing in the admin area depends on the one the device is working in.
  return (
    <AppShell tabs={TABS} operarioNombre={operario.nombre}>
      {children}
    </AppShell>
  )
}
