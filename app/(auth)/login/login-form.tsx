'use client'

import { useActionState } from 'react'
import { login } from './actions'

// `usuario` is what was typed: React empties the fields of a form when its action ends, even when the action
// answered with an error, so the field is filled again from here. The password is left empty on purpose.
type LoginState = { error: string; usuario: string } | null

export function LoginForm() {
  const [state, formAction, pending] = useActionState(
    async (_prev: LoginState, formData: FormData): Promise<LoginState> => {
      const result = await login(formData)
      return result ? { ...result, usuario: String(formData.get('login') ?? '') } : null
    },
    null,
  )

  return (
    <form action={formAction} className="login-form">
      <div className="login-field">
        <label htmlFor="login" className="label">Usuario</label>
        <input
          id="login"
          name="login"
          className="input"
          defaultValue={state?.usuario}
          required
          autoFocus
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <div className="login-field">
        <label htmlFor="password" className="label">Contraseña</label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          required
          autoComplete="current-password"
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
      {state?.error ? <p role="alert" className="banner banner-error">{state.error}</p> : null}
    </form>
  )
}
