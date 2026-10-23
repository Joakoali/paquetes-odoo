import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ErrorView } from './error-view'

function html(error: Error & { digest?: string }): string {
  return renderToStaticMarkup(createElement(ErrorView, { error, retry: vi.fn() }))
}

describe('ErrorView', () => {
  it('says something went wrong, and offers to try again', () => {
    const pagina = html(new Error('boom'))

    expect(pagina).toMatch(/<h1[^>]*>Algo salió mal\.<\/h1>/)
    expect(pagina).toMatch(/<button[^>]*type="button"[^>]*>Reintentar<\/button>/)
  })

  it('does not show what the error says: it is not for the operario', () => {
    const pagina = html(new Error('connection to server at "ep-secret-host" failed'))

    expect(pagina).not.toContain('ep-secret-host')
    expect(pagina).not.toContain('connection')
  })

  it('gives the digest, when there is one, so that the admin can find the error in the logs', () => {
    const error = Object.assign(new Error('boom'), { digest: '3829104' })

    expect(html(error)).toMatch(/Código para el admin<\/span><span class="mono">3829104<\/span>/)
  })

  it('has no code to give when there is no digest', () => {
    expect(html(new Error('boom'))).not.toContain('Código')
  })
})
