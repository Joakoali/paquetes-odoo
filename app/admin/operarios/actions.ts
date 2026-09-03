'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '../../../lib/auth/guards'
import { createOperario, setOperarioActivo } from '../../../lib/admin/operarios'

async function currentToken(): Promise<string | undefined> {
  const store = await cookies()
  return store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value
}

export async function createOperarioAction(formData: FormData): Promise<void> {
  await requireAdmin(await currentToken())
  await createOperario({
    nombre: String(formData.get('nombre')),
    login: String(formData.get('login')),
    password: String(formData.get('password')),
    rol: formData.get('rol') === 'admin' ? 'admin' : 'operario',
  })
  revalidatePath('/admin/operarios')
}

export async function toggleOperarioActivoAction(id: string, activo: boolean): Promise<void> {
  await requireAdmin(await currentToken())
  await setOperarioActivo(id, activo)
  revalidatePath('/admin/operarios')
}
