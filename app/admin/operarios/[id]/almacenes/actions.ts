'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth/guards'
import { setAlmacenesForOperario } from '@/lib/admin/operarioAlmacenes'

export async function updateAlmacenesAction(operarioId: string, formData: FormData): Promise<void> {
  const store = await cookies()
  await requireAdmin(store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value)
  const almacenIds = formData.getAll('almacenId').map((v) => Number(v))
  await setAlmacenesForOperario(operarioId, almacenIds)
  revalidatePath(`/admin/operarios/${operarioId}/almacenes`)
}
