import { LoginForm } from './login-form'

export default function LoginPage() {
  return (
    <main className="login">
      <div className="card login-card">
        <p className="label">Paquetería</p>
        <h1>Ingresar</h1>
        <LoginForm />
      </div>
    </main>
  )
}
