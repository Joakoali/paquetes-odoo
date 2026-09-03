// app/(app)/entrega/page.tsx
import { cookies } from 'next/headers'
import { requireOperario } from '@/lib/auth/guards'
import { getAlmacenesForOperario } from '@/lib/admin/operarioAlmacenes'
import { EntregaClient } from './EntregaClient'

export default async function EntregaPage() {
  const store = await cookies()
  const operario = await requireOperario(store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value)
  const almacenes = await getAlmacenesForOperario(operario.id)
  return <EntregaClient almacenes={almacenes} />
}
