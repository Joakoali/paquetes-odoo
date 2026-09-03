'use server'

import { eq } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { operarios } from '@/db/schema'
import { verifyPassword } from '@/lib/auth/password'
import { createSession } from '@/lib/auth/session'

export async function login(formData: FormData): Promise<{ error: string } | undefined> {
  const loginValue = String(formData.get('login') ?? '')
  const password = String(formData.get('password') ?? '')

  const operario = await db.query.operarios.findFirst({ where: eq(operarios.login, loginValue) })
  if (!operario || !operario.activo || !(await verifyPassword(password, operario.passwordHash))) {
    return { error: 'Usuario o contraseña incorrectos' }
  }

  const token = await createSession(operario.id)
  const cookieStore = await cookies()
  cookieStore.set(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12, // matches SESSION_TTL_MS in lib/auth/session.ts
  })
  redirect('/recepcion')
}
