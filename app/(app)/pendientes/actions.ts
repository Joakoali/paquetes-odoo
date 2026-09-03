'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireOperario } from '@/lib/auth/guards'
import { retrySession } from '@/lib/sync/pendientes'

export async function retrySessionAction(sesionId: string): Promise<void> {
  const store = await cookies()
  await requireOperario(store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value)
  await retrySession(sesionId)
  revalidatePath('/pendientes')
}
