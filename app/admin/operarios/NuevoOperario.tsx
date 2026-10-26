'use client'

import { useState, useTransition, type FormEvent } from 'react'
import { llamarAccion } from '@/lib/ui/textoDeFallo'
import { createOperarioAction } from './actions'

/** What a field of the form holds; a field that is not there reads as empty. */
const campo = (datos: FormData, nombre: string): string => String(datos.get(nombre) ?? '')

/**
 * The form that creates an operario. It stays disabled while the action runs, shows in words what the action
 * answers when it could not create it, and keeps what was typed in that case (so that a login that is taken is
 * a matter of changing the login). It is emptied only when the operario was created.
 *
 * Nothing here but `import type` may come from lib/acciones.ts: it is server-only.
 */
export function NuevoOperario() {
  const [ejecutandose, ejecutar] = useTransition()
  const [respuesta, setRespuesta] = useState<{ texto: string; ok: boolean } | null>(null)

  function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault()
    // Read before the first await: the event is not there after it.
    const formulario = evento.currentTarget
    const datos = new FormData(formulario)
    setRespuesta(null)
    ejecutar(async () => {
      const resultado = await llamarAccion(() => createOperarioAction({
        nombre: campo(datos, 'nombre'),
        login: campo(datos, 'login'),
        password: campo(datos, 'password'),
        rol: campo(datos, 'rol'),
      }))
      if (resultado.ok) {
        formulario.reset()
        setRespuesta({ texto: 'Operario creado.', ok: true })
      } else {
        setRespuesta({ texto: resultado.error, ok: false })
      }
    })
  }

  return (
    <form className="card" onSubmit={enviar}>
      <h2>Nuevo operario</h2>
      <div>
        <label className="label" htmlFor="nuevo-nombre">Nombre</label>
        <input id="nuevo-nombre" name="nombre" className="input" required autoComplete="off" />
      </div>
      <div>
        <label className="label" htmlFor="nuevo-login">Usuario</label>
        <input
          id="nuevo-login"
          name="login"
          className="input"
          required
          maxLength={64}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </div>
      <div>
        <label className="label" htmlFor="nuevo-password">Contraseña</label>
        <input id="nuevo-password" name="password" type="password" className="input" required autoComplete="new-password" />
      </div>
      <div>
        <label className="label" htmlFor="nuevo-rol">Rol</label>
        <select id="nuevo-rol" name="rol" className="input" defaultValue="operario">
          <option value="operario">Operario</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={ejecutandose}>Crear operario</button>
        {respuesta ? (
          <p role={respuesta.ok ? 'status' : 'alert'} className={`banner ${respuesta.ok ? 'banner-ok' : 'banner-error'}`}>
            {respuesta.texto}
          </p>
        ) : null}
      </div>
    </form>
  )
}
