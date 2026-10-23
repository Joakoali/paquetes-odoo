'use client'

import { useState, useTransition, type ReactNode } from 'react'
import type { ResultadoAccion } from '@/lib/acciones'
import { textoDeFallo } from './textoDeFallo'

/**
 * A button of a problem in Pendientes ("Reintentar", "Marcar como revisado"). It runs a server action on the
 * sesión and stays disabled while the action runs, so that a double tap does not run it twice. If the action
 * could not do it, the text it answers is shown next to the button. If it could, the action has revalidated
 * /pendientes and the list is drawn again: without the problem, or with it changed.
 *
 * The page hands it the action it runs (imported there from './actions', which Next turns into a reference for
 * the client) and the sesión. Nothing here but `import type` may come from lib/acciones.ts: it is server-only.
 */
export function AccionProblema({ accion, sesionId, className, children }: {
  accion: (sesionId: string) => Promise<ResultadoAccion>
  sesionId: string
  /** The classes of the button. */
  className: string
  /** The text of the button. */
  children: ReactNode
}) {
  const [ejecutandose, ejecutar] = useTransition()
  const [fallo, setFallo] = useState<string | null>(null)

  function apretar() {
    setFallo(null)
    ejecutar(async () => {
      setFallo(await textoDeFallo(accion, sesionId))
    })
  }

  return (
    <>
      <button type="button" className={className} disabled={ejecutandose} onClick={apretar}>
        {children}
      </button>
      {fallo ? <p role="alert" className="banner banner-error">{fallo}</p> : null}
    </>
  )
}
