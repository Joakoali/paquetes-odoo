'use client'

import { useEffect } from 'react'

/**
 * What the error.tsx of a route shows when something throws while a screen is drawn. The shell stays in place, so the
 * operario can go to another tab; "Reintentar" asks for the screen again. What the error says is not shown: in
 * production it is a generic text, and in any case it is not for the operario. The `digest` is: the admin can find
 * the matching error in the server logs with it.
 */
export function ErrorView({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="page">
      <h1>Algo salió mal.</h1>
      <p>Probá de nuevo. Si sigue pasando, avisá al admin.</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={() => retry()}>
          Reintentar
        </button>
      </div>
      {error.digest ? (
        <p>
          <span className="label">Código para el admin</span>
          <span className="mono">{error.digest}</span>
        </p>
      ) : null}
    </main>
  )
}
