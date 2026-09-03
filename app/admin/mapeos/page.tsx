import { db } from '@/db/client'
import { almacenes, couriers } from '@/db/schema'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { updateAlmacenMappingAction, updateCourierMappingAction } from './actions'

export default async function MapeosPage() {
  await requireAdminFromCookies()
  const [allAlmacenes, allCouriers] = await Promise.all([
    db.select().from(almacenes),
    db.select().from(couriers),
  ])

  return (
    <main>
      <h1>Mapeos con Odoo</h1>
      <p>
        Estos IDs deben completarse buscando los valores reales en el Odoo de destino
        antes de que recepción/entrega funcionen contra ese entorno.
      </p>
      <h2>Almacenes → picking_type_id</h2>
      {allAlmacenes.map((a) => (
        <form key={a.id} action={updateAlmacenMappingAction.bind(null, a.id)}>
          {a.prefijo}
          <input name="odooPickingTypeId" type="number" defaultValue={a.odooPickingTypeId ?? ''} required />
          <button type="submit">Guardar</button>
        </form>
      ))}
      <h2>Couriers → product_id</h2>
      {allCouriers.map((c) => (
        <form key={c.id} action={updateCourierMappingAction.bind(null, c.id)}>
          {c.nombre}
          <input name="odooProductId" type="number" defaultValue={c.odooProductId ?? ''} required />
          <button type="submit">Guardar</button>
        </form>
      ))}
    </main>
  )
}
