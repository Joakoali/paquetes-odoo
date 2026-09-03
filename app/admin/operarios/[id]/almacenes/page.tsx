import { db } from '@/db/client'
import { almacenes } from '@/db/schema'
import { getAlmacenesForOperario } from '@/lib/admin/operarioAlmacenes'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { updateAlmacenesAction } from './actions'

export default async function OperarioAlmacenesPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminFromCookies()
  const { id } = await params
  const [all, assigned] = await Promise.all([
    db.select().from(almacenes),
    getAlmacenesForOperario(id),
  ])
  const assignedIds = new Set(assigned.map((a) => a.id))

  return (
    <main>
      <h1>Almacenes asignados</h1>
      <form action={updateAlmacenesAction.bind(null, id)}>
        {all.map((a) => (
          <label key={a.id} style={{ display: 'block' }}>
            <input type="checkbox" name="almacenId" value={a.id} defaultChecked={assignedIds.has(a.id)} />
            {a.prefijo} — {a.nombre}
          </label>
        ))}
        <button type="submit">Guardar</button>
      </form>
    </main>
  )
}
