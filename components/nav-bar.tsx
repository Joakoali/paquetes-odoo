import Link from 'next/link'
import { logout } from '@/app/(auth)/logout/actions'

export interface NavLink {
  href: string
  label: string
}

/**
 * The shared top bar for every authenticated page. Rendered from the route-group
 * layouts, so it shows up on `/recepcion`, `/entrega`, `/pendientes` and the
 * whole `/admin` tree without each page wiring it up.
 */
export function NavBar({ links, operarioNombre }: { links: NavLink[]; operarioNombre?: string }) {
  return (
    <nav
      style={{
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '12px 16px',
        borderBottom: '1px solid #8886',
        marginBottom: 16,
      }}
    >
      {links.map((l) => (
        <Link key={l.href} href={l.href} style={{ textDecoration: 'underline' }}>
          {l.label}
        </Link>
      ))}
      {operarioNombre ? <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{operarioNombre}</span> : null}
      <form action={logout} style={{ marginLeft: operarioNombre ? 0 : 'auto' }}>
        <button type="submit">Cerrar sesión</button>
      </form>
    </nav>
  )
}
