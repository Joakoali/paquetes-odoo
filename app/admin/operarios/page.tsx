import Link from 'next/link'
import { listOperarios } from '@/lib/admin/operarios'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { createOperarioAction, toggleOperarioActivoAction } from './actions'

export default async function OperariosAdminPage() {
  await requireAdminFromCookies()
  const operarios = await listOperarios()
  return (
    <main>
      <h1>Operarios</h1>
      <form action={createOperarioAction}>
        <input name="nombre" placeholder="Nombre" required />
        <input name="login" placeholder="Usuario" required />
        <input name="password" type="password" placeholder="Contraseña" required />
        <select name="rol"><option value="operario">Operario</option><option value="admin">Admin</option></select>
        <button type="submit">Crear</button>
      </form>
      <ul>
        {operarios.map((op) => (
          <li key={op.id}>
            {op.nombre} ({op.login}) — {op.rol} — {op.activo ? 'activo' : 'inactivo'}
            {' — '}
            <Link href={`/admin/operarios/${op.id}/almacenes`} style={{ textDecoration: 'underline' }}>
              Almacenes
            </Link>
            <form action={toggleOperarioActivoAction.bind(null, op.id, !op.activo)}>
              <button type="submit">{op.activo ? 'Desactivar' : 'Activar'}</button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  )
}
