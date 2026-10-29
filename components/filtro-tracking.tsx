'use client'

import type { KeyboardEvent } from 'react'
import { MAX_CARACTERES_BUSQUEDA, textoDelFiltro } from '@/lib/ui/busqueda-tracking'
import { noRobarFoco } from '@/lib/ui/foco'

/**
 * The field that filters a list of packages by tracking number as it is typed, with what that leaves of the list under it
 * and the way to take the filter away. The list is the screen's: this only says what is in the field.
 *
 * Enter has nothing to send, since the list already shows what was typed: it closes the on-screen keyboard and calls
 * `onTerminar`. A screen with a scan field gives the focus back to it there, because the gun types wherever the focus is,
 * and its Enter is the one that would end up here if it fired while the operario was filtering. "Quitar filtro" does
 * not take the focus (`noRobarFoco`), and calls `onTerminar` too.
 */
export function FiltroTracking({ valor, onCambiar, visibles, total, onTerminar }: {
  valor: string
  onCambiar: (valor: string) => void
  /** The rows the filter leaves on the list. */
  visibles: number
  /** Every row of the list. */
  total: number
  onTerminar?: () => void
}) {
  const estado = textoDelFiltro({ visibles, total, buscado: valor })

  function alTeclear(evento: KeyboardEvent<HTMLInputElement>) {
    if (evento.key !== 'Enter') return
    evento.preventDefault()
    evento.currentTarget.blur()
    onTerminar?.()
  }

  function quitar() {
    onCambiar('')
    onTerminar?.()
  }

  return (
    <div className="filtro-tracking">
      <input
        type="search"
        className="input"
        aria-label="Filtrar por tracking nº"
        placeholder="Filtrar por tracking nº…"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        maxLength={MAX_CARACTERES_BUSQUEDA}
        value={valor}
        onChange={(evento) => onCambiar(evento.target.value)}
        onKeyDown={alTeclear}
      />
      <div className="filtro-tracking-estado" role="status">
        {estado ? (
          <>
            <span className="busqueda-estado">{estado}</span>
            <button type="button" className="btn-link" onPointerDown={noRobarFoco} onClick={quitar}>Quitar filtro</button>
          </>
        ) : null}
      </div>
    </div>
  )
}
