'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { destroySession } from '@/lib/auth/session'

export async function logout(): Promise<void> {
  const cookieStore = await cookies()
  const name = process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session'
  const token = cookieStore.get(name)?.value
  if (token) await destroySession(token)
  cookieStore.delete(name)
  redirect('/login')
}
