'use client'

import { Fragment, useState, type ReactNode } from 'react'
import { coincideAlguno, mostrarFiltro } from '@/lib/ui/busqueda-tracking'
import { FiltroTracking } from './filtro-tracking'

/** A row of a list that a server page draws, with the tracking numbers it is found by. */
export interface ElementoFiltrable {
  clave: string
  trackingNumbers: ReadonlyArray<string | null>
  /** The row as the page drew it: an <li>. */
  contenido: ReactNode
}

/**
 * A list whose rows a server page draws (the packages of a recepción that was sent, the problems of Pendientes), with the
 * filter by tracking number over it, which filters it here, as it is typed. A row stays while any of its tracking numbers
 * has what was typed. The filter is there from MIN_PARA_FILTRAR rows, or when the page is opened with one (`filtroInicial`,
 * the `q` of its address, which is how the search of a package leads to it).
 */
export function ListaFiltrable({ elementos, filtroInicial, className }: {
  elementos: ElementoFiltrable[]
  filtroInicial: string
  /** The classes of the <ul>. */
  className?: string
}) {
  const [filtro, setFiltro] = useState(filtroInicial)
  const visibles = elementos.filter((elemento) => coincideAlguno(elemento.trackingNumbers, filtro))

  return (
    <>
      {mostrarFiltro(elementos.length, filtroInicial) ? (
        <FiltroTracking valor={filtro} onCambiar={setFiltro} visibles={visibles.length} total={elementos.length} />
      ) : null}
      {visibles.length > 0 ? (
        <ul className={className}>
          {visibles.map((elemento) => <Fragment key={elemento.clave}>{elemento.contenido}</Fragment>)}
        </ul>
      ) : null}
    </>
  )
}
