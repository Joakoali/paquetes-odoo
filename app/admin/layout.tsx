import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { NavBar } from '@/components/nav-bar'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const operario = await requireAdminFromCookies().catch((err) => {
    redirect(err instanceof UnauthorizedError ? '/login' : '/recepcion')
  })

  return (
    <>
      <NavBar
        links={[
          { href: '/recepcion', label: '← App' },
          { href: '/admin/operarios', label: 'Operarios' },
          { href: '/admin/mapeos', label: 'Mapeos' },
        ]}
        operarioNombre={operario.nombre}
      />
      {children}
    </>
  )
}
