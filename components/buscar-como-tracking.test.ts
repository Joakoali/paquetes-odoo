import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BuscarComoTracking } from './buscar-como-tracking'

const dibujar = (escrito: string) => renderToStaticMarkup(createElement(BuscarComoTracking, { escrito }))

describe('BuscarComoTracking', () => {
  it('offers to search what was typed as a tracking number, in the search of a package', () => {
    expect(dibujar(' JJD0588 ')).toBe(
      '<a class="btn-link buscar-como-tracking" href="/buscar?q=JJD0588">Buscar «JJD0588» como tracking nº ›</a>',
    )
  })

  it('offers nothing for what is too short to be searched', () => {
    expect(dibujar('058')).toBe('')
    expect(dibujar(' 0 5 8 ')).toBe('')
  })

  it('puts what was typed in the address as text, whatever it has', () => {
    expect(dibujar('AB 12&q=x')).toContain('href="/buscar?q=AB%2012%26q%3Dx"')
  })
})
