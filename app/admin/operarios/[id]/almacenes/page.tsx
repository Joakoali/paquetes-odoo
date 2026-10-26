import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { operarios } from '@/db/schema'
import { getAlmacenesForOperario, listAlmacenesActivos } from '@/lib/admin/operarioAlmacenes'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { FormAlmacenes } from './FormAlmacenes'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function OperarioAlmacenesPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminFromCookies()
  const { id } = await params
  // Postgres would refuse anything but a uuid with an error; an id that is not one names nobody.
  const operario = UUID.test(id)
    ? await db.query.operarios.findFirst({ columns: { nombre: true }, where: eq(operarios.id, id) })
    : undefined
  if (!operario) notFound()

  // Only the active almacenes: the ones Odoo no longer has cannot be worked in, so there is nothing to choose there.
  const [activos, asignados] = await Promise.all([listAlmacenesActivos(), getAlmacenesForOperario(id)])

  return (
    <main className="page">
      <header className="barco-cabecera">
        <Link href="/admin/operarios" className="btn-link">‹ Operarios</Link>
        <h1 className="barco-nombre">Almacenes de {operario.nombre}</h1>
      </header>
      {activos.length === 0 ? (
        <p>No hay almacenes activos. Se cargan solos desde Odoo: probá refrescar en Datos de Odoo.</p>
      ) : (
        <FormAlmacenes
          operarioId={id}
          almacenes={activos.map(({ id: almacenId, prefijo, nombre }) => ({ id: almacenId, prefijo, nombre }))}
          asignados={asignados.map((almacen) => almacen.id)}
        />
      )}
    </main>
  )
}
