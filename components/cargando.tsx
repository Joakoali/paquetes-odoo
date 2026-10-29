import type { ReactNode } from 'react'

/**
 * What a screen shows while the server reads what it needs: Odoo, on the screens of Entrega. Next prefetches it with
 * the links to the screen, so it is there the moment one is touched, instead of the old screen staying put until the
 * answer comes. `children` is what goes above the text, such as the way back of a screen that has one.
 *
 * Not for the screens of Recepción: while one of them is on its way out it still hears the gun and refuses aloud the
 * codes that arrive, and this one has no scan field.
 */
export function Cargando({ texto, children }: { texto: string; children?: ReactNode }) {
  return (
    <main className="page" aria-busy="true">
      {children}
      <p className="lista-vacia" role="status">{texto}</p>
    </main>
  )
}
