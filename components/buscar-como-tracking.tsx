'use client'

import Link from 'next/link'
import { textoDeBusqueda } from '@/lib/ui/busqueda-tracking'
import { noRobarFoco } from '@/lib/ui/foco'

/**
 * What a search of barcos offers when no barco is called what was typed: to search it as a tracking number, since it may
 * be one (an operario with a package in hand, looking for its barco). Only when it is long enough to be searched.
 *
 * It does not take the focus (`noRobarFoco`): on the home of Recepción the gun is heard by a field that must keep it.
 */
export function BuscarComoTracking({ escrito }: { escrito: string }) {
  if (textoDeBusqueda(escrito) === null) return null
  const texto = escrito.trim()

  return (
    <Link href={`/buscar?q=${encodeURIComponent(texto)}`} className="btn-link buscar-como-tracking" onPointerDown={noRobarFoco}>
      Buscar «{texto}» como tracking nº ›
    </Link>
  )
}
