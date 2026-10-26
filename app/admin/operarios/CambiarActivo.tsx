'use client'

import { useState, useTransition } from 'react'
import { llamarAccion } from '@/lib/ui/textoDeFallo'
import { toggleOperarioActivoAction } from './actions'

/**
 * "Desactivar" / "Activar" of an operario in the list: it asks for the opposite of what the operario is now. It stays
 * disabled while the action runs, and if the action could not do it, the text it answers is shown next to the button.
 * If it could, the action has revalidated the list and it is drawn again with the operario changed.
 *
 * Nothing here but `import type` may come from lib/acciones.ts: it is server-only.
 */
export function CambiarActivo({ id, nombre, activo }: { id: string; nombre: string; activo: boolean }) {
  const [ejecutandose, ejecutar] = useTransition()
  const [fallo, setFallo] = useState<string | null>(null)

  function apretar() {
    setFallo(null)
    ejecutar(async () => {
      const resultado = await llamarAccion(() => toggleOperarioActivoAction(id, !activo))
      setFallo(resultado.ok ? null : resultado.error)
    })
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={ejecutandose}
        aria-label={`${activo ? 'Desactivar' : 'Activar'} a ${nombre}`}
        onClick={apretar}
      >
        {activo ? 'Desactivar' : 'Activar'}
      </button>
      {fallo ? <p role="alert" className="banner banner-error">{fallo}</p> : null}
    </>
  )
}
