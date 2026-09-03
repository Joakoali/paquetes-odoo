'use client'

import { useActionState } from 'react'
import { login } from './actions'

type LoginState = { error: string } | null

export function LoginForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: LoginState, formData: FormData): Promise<LoginState> => {
      const result = await login(formData)
      return result ?? null
    },
    null,
  )

  return (
    <form
      action={formAction}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320, margin: '4rem auto' }}
    >
      <h1>Ingresar</h1>
      <input name="login" placeholder="Usuario" required autoFocus autoComplete="username" />
      <input
        name="password"
        type="password"
        placeholder="Contraseña"
        required
        autoComplete="current-password"
      />
      <button type="submit" disabled={pending}>
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
      {state?.error ? <p role="alert" style={{ color: 'crimson' }}>{state.error}</p> : null}
    </form>
  )
}
