'use client'

import { useState } from 'react'
// Types only: lib/recepcion/couriers.ts reaches the database, which must not get into the client.
import type { CourierOpcion } from '@/lib/recepcion/couriers'
import { filtrarCouriers } from '@/lib/ui/courier-elegido'
import { noRobarFoco } from '@/lib/ui/foco'

/**
 * The courier the next packages are scanned under. The most used ones are chips, and the one chosen stays marked
 * until another is touched. "Otro courier…" opens the list of all of them, with a filter, for the rest (Odoo has
 * more than seventy); if the one chosen is not among the chips it is shown as one more, marked, so that what is
 * chosen is always in sight.
 *
 * Every button keeps the focus where it is (`noRobarFoco`): this screen has a scan field that must have it. The
 * filter is a field of its own and does take it, since the operario types in it.
 */
export function CourierPicker({ frecuentes, todos, elegidoId, onElegir }: {
  frecuentes: CourierOpcion[]
  todos: CourierOpcion[]
  elegidoId: number | null
  onElegir: (courier: CourierOpcion) => void
}) {
  const [abierto, setAbierto] = useState(false)
  const [filtro, setFiltro] = useState('')

  const fueraDeLosChips = elegidoId === null || frecuentes.some((courier) => courier.id === elegidoId)
    ? undefined
    : todos.find((courier) => courier.id === elegidoId)
  const coincidencias = filtrarCouriers(todos, filtro)

  function elegir(courier: CourierOpcion) {
    onElegir(courier)
    cerrar()
  }

  function cerrar() {
    setAbierto(false)
    setFiltro('')
  }

  const chip = (courier: CourierOpcion) => (
    <button
      key={courier.id}
      type="button"
      className="chip"
      aria-pressed={courier.id === elegidoId}
      onPointerDown={noRobarFoco}
      onClick={() => elegir(courier)}
    >
      {courier.nombre}
    </button>
  )

  return (
    <div className="couriers">
      <div className="chips">
        {frecuentes.map(chip)}
        {fueraDeLosChips ? chip(fueraDeLosChips) : null}
        <button
          type="button"
          className="chip chip-otro"
          aria-expanded={abierto}
          onPointerDown={noRobarFoco}
          onClick={() => (abierto ? cerrar() : setAbierto(true))}
        >
          Otro courier…
        </button>
      </div>

      {abierto ? (
        <div className="card couriers-otros">
          <input
            type="search"
            className="input"
            aria-label="Buscar courier"
            placeholder="Buscar courier…"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={filtro}
            onChange={(evento) => setFiltro(evento.target.value)}
          />
          {coincidencias.length === 0 ? (
            <p className="couriers-vacio">Ningún courier se llama así.</p>
          ) : (
            <ul className="list couriers-lista">
              {coincidencias.map((courier) => (
                <li key={courier.id}>
                  <button
                    type="button"
                    className="list-row"
                    aria-pressed={courier.id === elegidoId}
                    onPointerDown={noRobarFoco}
                    onClick={() => elegir(courier)}
                  >
                    {courier.nombre}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
