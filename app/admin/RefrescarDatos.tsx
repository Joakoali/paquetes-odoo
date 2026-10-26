'use client'

import { useState, useTransition } from 'react'
import { llamarAccion } from '@/lib/ui/textoDeFallo'
import { refrescarDatosOdooAction } from './actions'

/** What the admin reads after the button: it was queued, not done, so it says how long to wait. */
const ENCOLADO = 'Encolado. Tarda uno o dos minutos.'

/**
 * The "Refrescar ahora" button of Datos de Odoo. It enqueues the refresh and says so: the data does not change
 * on the spot, so the page is not redrawn. It stays disabled while the action runs, so that a double tap does not
 * queue it twice, and if the action could not do it, the text it answers is shown under the button.
 *
 * Nothing here but `import type` may come from lib/acciones.ts: it is server-only.
 */
export function RefrescarDatos() {
  const [ejecutandose, ejecutar] = useTransition()
  const [respuesta, setRespuesta] = useState<{ texto: string; ok: boolean } | null>(null)

  function apretar() {
    setRespuesta(null)
    ejecutar(async () => {
      const resultado = await llamarAccion(refrescarDatosOdooAction)
      setRespuesta(resultado.ok ? { texto: ENCOLADO, ok: true } : { texto: resultado.error, ok: false })
    })
  }

  return (
    <div className="actions">
      <button type="button" className="btn btn-primary" disabled={ejecutandose} onClick={apretar}>
        Refrescar ahora
      </button>
      {respuesta ? (
        <p role={respuesta.ok ? 'status' : 'alert'} className={`banner ${respuesta.ok ? 'banner-ok' : 'banner-error'}`}>
          {respuesta.texto}
        </p>
      ) : null}
    </div>
  )
}
