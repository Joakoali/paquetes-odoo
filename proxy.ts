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

/**
 * The screens of the app, but not the Server Actions called on them (a POST to the screen with a `next-action`
 * header). Every action authenticates by itself, and a scan is one of them: going through the proxy only added a step
 * to every code of the gun, and the redirect it answers without a cookie reached the screen as "no answer" instead of
 * the expired-session message the action gives. Each entry is written out whole because Next reads the matcher at
 * build time and ignores whatever comes from a variable.
 */
export const config = {
  matcher: [
    { source: '/admin', missing: [{ type: 'header', key: 'next-action' }] },
    { source: '/admin/:path*', missing: [{ type: 'header', key: 'next-action' }] },
    { source: '/recepcion/:path*', missing: [{ type: 'header', key: 'next-action' }] },
    { source: '/entrega/:path*', missing: [{ type: 'header', key: 'next-action' }] },
    { source: '/pendientes/:path*', missing: [{ type: 'header', key: 'next-action' }] },
    { source: '/buscar/:path*', missing: [{ type: 'header', key: 'next-action' }] },
  ],
}
