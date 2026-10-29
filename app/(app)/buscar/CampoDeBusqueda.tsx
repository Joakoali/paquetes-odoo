'use client'

import Form from 'next/form'
import { useRef } from 'react'
import { MAX_CARACTERES_BUSQUEDA } from '@/lib/ui/busqueda-tracking'

/**
 * The field of the search of a package, in a form that goes to /buscar?q=…: a navigation and not an action, so that the
 * address is the search and "Atrás" goes back to the one before.
 *
 * It is for the gun too, which types the code and presses Enter. The field has the focus when the screen opens, and what
 * is in it is left selected after each search, so that the next code the gun types takes its place instead of being added
 * to it. A new search draws the field again (`key`), selected by its focus; the same search again does not, and the
 * selection is made when the form is sent.
 */
export function CampoDeBusqueda({ valor }: { valor: string }) {
  const campo = useRef<HTMLInputElement>(null)

  return (
    <Form action="/buscar" className="busqueda-form" onSubmit={() => campo.current?.select()}>
      <input
        key={valor}
        ref={campo}
        name="q"
        type="search"
        className="input"
        aria-label="Tracking nº"
        placeholder="Tracking nº…"
        defaultValue={valor}
        maxLength={MAX_CARACTERES_BUSQUEDA}
        autoFocus
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        onFocus={(evento) => evento.currentTarget.select()}
      />
      <button type="submit" className="btn btn-primary">Buscar</button>
    </Form>
  )
}
