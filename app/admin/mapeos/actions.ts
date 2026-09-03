'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth/guards'
import { setAlmacenOdooPickingTypeId, setCourierOdooProductId } from '@/lib/admin/odooMappings'

async function currentToken(): Promise<string | undefined> {
  const store = await cookies()
  return store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value
}

export async function updateAlmacenMappingAction(almacenId: number, formData: FormData): Promise<void> {
  await requireAdmin(await currentToken())
  await setAlmacenOdooPickingTypeId(almacenId, Number(formData.get('odooPickingTypeId')))
  revalidatePath('/admin/mapeos')
}

export async function updateCourierMappingAction(courierId: number, formData: FormData): Promise<void> {
  await requireAdmin(await currentToken())
  await setCourierOdooProductId(courierId, Number(formData.get('odooProductId')))
  revalidatePath('/admin/mapeos')
}
