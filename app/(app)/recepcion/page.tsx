// app/(app)/recepcion/page.tsx
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { getAlmacenesForOperario } from '@/lib/admin/operarioAlmacenes'
import { db } from '@/db/client'
import { couriers } from '@/db/schema'
import { ScanClient } from './ScanClient'

export default async function RecepcionPage() {
  const operario = await requireOperarioFromCookies()
  const [almacenes, allCouriers] = await Promise.all([
    getAlmacenesForOperario(operario.id),
    db.select().from(couriers),
  ])

  return <ScanClient almacenes={almacenes} couriers={allCouriers} />
}
