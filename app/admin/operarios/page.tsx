import Link from 'next/link'
import { listOperariosConAlmacenes } from '@/lib/admin/operarios'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { CambiarActivo } from './CambiarActivo'
import { NuevoOperario } from './NuevoOperario'

export default async function OperariosAdminPage() {
  await requireAdminFromCookies()
  const operarios = await listOperariosConAlmacenes()

  return (
    <main className="page">
      <h1>Operarios</h1>

      <NuevoOperario />

      <ul>
        {operarios.map((operario) => (
          <li key={operario.id} className="card">
            <h2>{operario.nombre}</h2>
            <p>
              <span className="badge">{operario.rol === 'admin' ? 'Admin' : 'Operario'}</span>
              <span className="badge">{operario.activo ? 'Activo' : 'Inactivo'}</span>
            </p>
            <p className="fila-meta">Usuario <span className="mono">{operario.login}</span></p>
            <p className="fila-meta">
              {operario.almacenes.length > 0 ? (
                <>Almacenes <span className="mono">{operario.almacenes.join(', ')}</span></>
              ) : 'Sin almacenes asignados'}
            </p>
            <div className="actions">
              <Link href={`/admin/operarios/${operario.id}/almacenes`} className="btn btn-secondary">
                Elegir almacenes
              </Link>
              <CambiarActivo id={operario.id} nombre={operario.nombre} activo={operario.activo} />
            </div>
          </li>
        ))}
      </ul>
    </main>
  )
}
