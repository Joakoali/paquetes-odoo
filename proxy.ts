import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Next 16 renamed Middleware to Proxy. This is an *optimistic* check only — it
 * runs before the request reaches the app and cannot touch the database, so it
 * only asks "is there a session cookie at all?" and bounces to /login if not.
 * The real `requireOperario` / `requireAdmin` validation stays in the pages and
 * server actions.
 */
export function proxy(request: NextRequest): NextResponse {
  const token = request.cookies.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value
  if (token) return NextResponse.next()

  const login = new URL('/login', request.url)
  return NextResponse.redirect(login)
}

export const config = {
  matcher: [
    '/admin',
    '/admin/:path*',
    '/recepcion/:path*',
    '/entrega/:path*',
    '/pendientes/:path*',
  ],
}
