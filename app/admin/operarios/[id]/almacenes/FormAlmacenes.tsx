'use client'

import { useState, useTransition, type FormEvent } from 'react'
import { llamarAccion } from '@/lib/ui/textoDeFallo'
import { updateAlmacenesAction } from './actions'

/**
 * The almacenes the admin can tick for an operario, and the button that saves them. It stays disabled while the
 * action runs, and says in words that it was saved, or why it was not (what was ticked stays on screen in that case).
 *
 * Only what the page gives it is on screen: the active almacenes. Saving speaks for those alone, which is why the
 * ones that went inactive are not in `almacenes` and are not lost by saving.
 *
 * Nothing here but `import type` may come from lib/acciones.ts: it is server-only.
 */
export function FormAlmacenes({ operarioId, almacenes, asignados }: {
  operarioId: string
  almacenes: Array<{ id: number; prefijo: string; nombre: string }>
  /** The ids of the almacenes the operario has now. */
  asignados: number[]
}) {
  const [ejecutandose, ejecutar] = useTransition()
  const [respuesta, setRespuesta] = useState<{ texto: string; ok: boolean } | null>(null)

  function guardar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault()
    const elegidos = new FormData(evento.currentTarget).getAll('almacenId').map(Number)
    setRespuesta(null)
    ejecutar(async () => {
      const resultado = await llamarAccion(() => updateAlmacenesAction(operarioId, elegidos))
      setRespuesta(resultado.ok ? { texto: 'Guardado.', ok: true } : { texto: resultado.error, ok: false })
    })
  }

  return (
    <form className="form-almacenes" onSubmit={guardar}>
      <ul className="list">
        {almacenes.map((almacen) => (
          <li key={almacen.id}>
            <label className="list-row fila-marca">
              <input type="checkbox" name="almacenId" value={almacen.id} defaultChecked={asignados.includes(almacen.id)} />
              <span className="fila-texto">
                <span className="fila-nombre">{almacen.nombre}</span>
                <span className="fila-meta mono">{almacen.prefijo}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={ejecutandose}>Guardar</button>
        {respuesta ? (
          <p role={respuesta.ok ? 'status' : 'alert'} className={`banner ${respuesta.ok ? 'banner-ok' : 'banner-error'}`}>
            {respuesta.texto}
          </p>
        ) : null}
      </div>
    </form>
  )
}
