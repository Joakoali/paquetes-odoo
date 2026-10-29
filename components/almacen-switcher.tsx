'use client'

import { useEffect, useState, useTransition } from 'react'
import { elegirAlmacenAction } from '@/app/(app)/almacen-actions'
// Types only: lib/almacen-activo.ts and db/ pull in the database, which must not get into the client.
import type { Almacen } from '@/db/schema'
import { ignorarTeclas } from '@/lib/ui/foco'

export type AlmacenOpcion = Pick<Almacen, 'id' | 'prefijo' | 'nombre'>

const MENSAJE_SIN_CONEXION = 'No se pudo cambiar de almacén. Probá de nuevo.'

/** How long the reason of a failure stays on screen. */
const SEGUNDOS_DEL_AVISO = 8

/**
 * The almacén the operario is working in, as a pill that opens the device's own picker. The shell shows it only
 * when the operario has more than one almacén.
 *
 * It never holds the choice: it always shows `activoId`, which the server worked out (`getAlmacenActivo`). The
 * server may not do what was asked (the almacén went inactive meanwhile, the session expired), and then the pill
 * must keep telling the almacén that is really in use. The action sets a cookie, which makes Next render the page
 * again in its answer: the new `activoId` arrives with it, and asking for the page once more would render it twice.
 *
 * It is for touch only. The barcode gun types like a keyboard, and a code that is scanned while this select has the
 * focus would choose an almacén by type-ahead, with nobody having touched it. So the select ignores the keyboard
 * (except Tab) and does not keep the focus once it has chosen: the screens with a scan field take it back.
 */
export function AlmacenSwitcher({ activoId, disponibles }: { activoId: number; disponibles: AlmacenOpcion[] }) {
  const [cambiando, cambiar] = useTransition()
  const [fallo, setFallo] = useState<string | null>(null)
  const activo = disponibles.find((almacen) => almacen.id === activoId)

  useEffect(() => {
    if (!fallo) return
    const aviso = setTimeout(() => setFallo(null), SEGUNDOS_DEL_AVISO * 1000)
    return () => clearTimeout(aviso)
  }, [fallo])

  function elegir(almacenId: number) {
    setFallo(null)
    cambiar(async () => {
      try {
        const resultado = await elegirAlmacenAction(almacenId)
        if (!resultado.ok) setFallo(resultado.error)
      } catch {
        // The action answers what can be expected as a value; this is the connection failing.
        setFallo(MENSAJE_SIN_CONEXION)
      }
    })
  }

  return (
    <div className="shell-almacen" aria-busy={cambiando}>
      <span className="shell-almacen-pill" aria-hidden="true">
        {activo?.prefijo ?? '—'}
        <span>{cambiando ? '…' : '▾'}</span>
      </span>
      <select
        aria-label="Almacén"
        value={activoId}
        disabled={cambiando}
        onKeyDown={ignorarTeclas}
        onChange={(evento) => {
          const almacenId = Number(evento.target.value)
          evento.target.blur()
          elegir(almacenId)
        }}
      >
        {disponibles.map((almacen) => (
          <option key={almacen.id} value={almacen.id}>
            {almacen.prefijo} · {almacen.nombre}
          </option>
        ))}
      </select>
      {fallo ? <p role="alert" className="banner banner-error shell-almacen-error">{fallo}</p> : null}
    </div>
  )
}
