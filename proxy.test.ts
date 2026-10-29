import { describe, expect, it } from 'vitest'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { config } from './proxy'

/** The screens behind a session: each one, and one below it. */
const PANTALLAS = [
  '/admin', '/admin/operarios',
  '/recepcion', '/recepcion/7b1e4a52-1f0c-4c55-9a1e-2f3c4d5e6f70',
  '/entrega', '/entrega/673',
  '/pendientes',
  '/buscar', '/buscar?q=0588',
]

describe('the matcher of the proxy', () => {
  it.each(PANTALLAS)('checks the cookie of a request for the screen %s', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true)
  })

  it.each(PANTALLAS)('lets a Server Action on %s through: the action authenticates by itself', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url, headers: { 'next-action': '7f3a1c' } })).toBe(false)
  })

  it.each(['/login', '/', '/manifest.webmanifest', '/api/qstash/sync-session'])('leaves %s alone', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false)
  })
})
