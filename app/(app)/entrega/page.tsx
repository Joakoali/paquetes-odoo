// app/(app)/entrega/page.tsx
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { getAlmacenesForOperario } from '@/lib/admin/operarioAlmacenes'
import { EntregaClient } from './EntregaClient'

export default async function EntregaPage() {
  const operario = await requireOperarioFromCookies()
  const almacenes = await getAlmacenesForOperario(operario.id)
  return <EntregaClient almacenes={almacenes} />
}
