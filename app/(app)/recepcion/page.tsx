// app/(app)/recepcion/page.tsx
import { cookies } from 'next/headers'
import { requireOperario } from '@/lib/auth/guards'
import { getAlmacenesForOperario } from '@/lib/admin/operarioAlmacenes'
import { db } from '@/db/client'
import { couriers } from '@/db/schema'
import { ScanClient } from './ScanClient'

export default async function RecepcionPage() {
  const store = await cookies()
  const operario = await requireOperario(store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value)
  const [almacenes, allCouriers] = await Promise.all([
    getAlmacenesForOperario(operario.id),
    db.select().from(couriers),
  ])

  return <ScanClient almacenes={almacenes} couriers={allCouriers} />
}
