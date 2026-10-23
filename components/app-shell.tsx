import type { ReactNode } from 'react'
import { logout } from '@/app/(auth)/logout/actions'
import type { AlmacenesDelOperario } from '@/lib/almacen-activo'
import { AlmacenSwitcher } from './almacen-switcher'
import { NavTabs, type Tab } from './nav-tabs'

export type { Tab }

/** The almacén in the bar: changeable when there is more than one, and only said when there is one. */
function AlmacenDeLaCabecera({ almacenes }: { almacenes: AlmacenesDelOperario }) {
  const { activo, disponibles } = almacenes

  if (!activo) {
    return (
      <div className="shell-almacen">
        <span className="shell-almacen-pill shell-almacen-pill-vacio">Sin almacén</span>
      </div>
    )
  }
  if (disponibles.length > 1) {
    // Only what the pill and the picker show goes to the client, not the whole row of each almacén.
    const opciones = disponibles.map(({ id, prefijo, nombre }) => ({ id, prefijo, nombre }))
    return <AlmacenSwitcher activoId={activo.id} disponibles={opciones} />
  }
  return (
    <div className="shell-almacen">
      <span className="shell-almacen-pill">{activo.prefijo}</span>
    </div>
  )
}

/**
 * What every screen of the app sits in: the tabs, the almacén being worked in, who is working and "Cerrar sesión".
 * `almacenes` is what `getAlmacenActivo` answers; the admin area leaves it out, since its screens do not depend on
 * an almacén. The screens bring their own <main>.
 */
export function AppShell({ tabs, almacenes, operarioNombre, children }: {
  tabs: Tab[]
  almacenes?: AlmacenesDelOperario
  operarioNombre: string
  children: ReactNode
}) {
  return (
    <div className="shell">
      <header className="shell-bar">
        <NavTabs tabs={tabs} />
        <div className="shell-who">
          {almacenes ? <AlmacenDeLaCabecera almacenes={almacenes} /> : null}
          <span className="shell-user">{operarioNombre}</span>
          <form action={logout}>
            <button type="submit" className="btn-link">Cerrar sesión</button>
          </form>
        </div>
      </header>
      <div className="shell-content">{children}</div>
    </div>
  )
}
