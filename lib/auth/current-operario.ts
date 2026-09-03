import { cookies } from 'next/headers'
import { requireOperario, requireAdmin } from './guards'
import type { Operario } from '../../db/schema'

function cookieName(): string {
  return process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session'
}

async function currentToken(): Promise<string | undefined> {
  const store = await cookies()
  return store.get(cookieName())?.value
}

/**
 * The cookie-read + `requireOperario` block every server action and guarded
 * page needs. Throws `UnauthorizedError` when there is no valid session.
 */
export async function requireOperarioFromCookies(): Promise<Operario> {
  return requireOperario(await currentToken())
}

/** Same, but also demands the `admin` role (throws `ForbiddenError` if not). */
export async function requireAdminFromCookies(): Promise<Operario> {
  return requireAdmin(await currentToken())
}
