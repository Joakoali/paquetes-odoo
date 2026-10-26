'use client'

import Link from 'next/link'
import { noRobarFoco } from '@/lib/ui/foco'

/**
 * The header of a recepción: "volver", the name of the barco in large type and, on the right, the almacén it
 * belongs to. The almacén is the recepción's own, which is not always the one in the bar of the app: that one is
 * the almacén the operario is working in, and it is shown only to those who have more than one.
 *
 * The link does not take the focus, so that on the screen with a scan field a touch on it never leaves the gun
 * typing into a link. It is a client component for that (a function cannot be handed to it from a server one).
 */
export function CabeceraDeBarco({ barcoNombre, almacenPrefijo }: { barcoNombre: string; almacenPrefijo: string }) {
  return (
    <header className="barco-cabecera">
      <Link href="/recepcion" className="btn-link" onPointerDown={noRobarFoco}>‹ Recepciones</Link>
      <h1 className="barco-nombre">{barcoNombre}</h1>
      <span className="barco-almacen">{almacenPrefijo}</span>
    </header>
  )
}
