import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FiltroTracking } from './filtro-tracking'
import { ListaFiltrable, type ElementoFiltrable } from './lista-filtrable'

/** A row drawn as a page would, found by its tracking numbers. */
const fila = (clave: string, ...trackingNumbers: Array<string | null>): ElementoFiltrable => ({
  clave, trackingNumbers, contenido: createElement('li', { className: 'fila' }, `FILA-${clave}`),
})

/** The list as the browser is first given it. */
const dibujar = (elementos: ElementoFiltrable[], filtroInicial = '') =>
  renderToStaticMarkup(createElement(ListaFiltrable, { elementos, filtroInicial, className: 'list' }))

describe('ListaFiltrable', () => {
  it('draws every row, in its order and with no filter, when the list is short and opened with none', () => {
    const html = dibujar([fila('a', 'JJD0001'), fila('b', null), fila('c', 'JJD0003')])

    expect(html.match(/FILA-[abc]/g)).toEqual(['FILA-a', 'FILA-b', 'FILA-c'])
    expect(html).toMatch(/^<ul class="list">/)
    expect(html).not.toContain('<input')
  })

  it('has the filter from six rows', () => {
    const html = dibujar(['a', 'b', 'c', 'd', 'e', 'f'].map((clave) => fila(clave, `JJD-${clave}`)))

    expect(html).toContain('aria-label="Filtrar por tracking nº"')
    expect(html.match(/FILA-/g)).toHaveLength(6)
  })

  it('opens with the filter it is given, leaving the rows any of whose packages has it', () => {
    const html = dibujar([fila('a', 'JJD0001'), fila('b', 'XW0002', 'JJD0588'), fila('c', null), fila('d')], '0588')

    expect(html.match(/FILA-[abcd]/g)).toEqual(['FILA-b'])
    expect(html).toContain('value="0588"')
    expect(html).toContain('Mostrando 1 de 4')
  })

  it('draws no list, only what the filter says, when no row has what it opened with', () => {
    const html = dibujar([fila('a', 'JJD0001')], '9999')

    expect(html).not.toContain('<ul')
    expect(html).toContain('Ningún paquete tiene «9999» en el tracking.')
  })
})

describe('FiltroTracking', () => {
  const dibujarFiltro = (valor: string, visibles: number, total: number) =>
    renderToStaticMarkup(createElement(FiltroTracking, { valor, onCambiar: vi.fn(), visibles, total }))

  it('is a search field that does not correct or capitalize what is typed', () => {
    const html = dibujarFiltro('', 6, 6)

    expect(html).toMatch(/<input type="search"[^>]*placeholder="Filtrar por tracking nº…"/)
    for (const atributo of ['autoComplete="off"', 'autoCapitalize="off"', 'autoCorrect="off"', 'spellCheck="false"', 'enterKeyHint="search"']) {
      expect(html).toContain(atributo)
    }
  })

  it('says nothing and offers nothing to take away while nothing is typed', () => {
    const html = dibujarFiltro('', 6, 6)

    expect(html).toContain('<div class="filtro-tracking-estado" role="status"></div>')
    expect(html).not.toContain('Quitar filtro')
  })

  it('says how many rows it leaves, with the way to take it away', () => {
    const html = dibujarFiltro('0588', 1, 23)

    expect(html).toContain('Mostrando 1 de 23')
    expect(html).toMatch(/<button type="button" class="btn-link">Quitar filtro<\/button>/)
  })

  it('does not let what was typed act as HTML', () => {
    const html = dibujarFiltro('<img src=x>', 0, 3)

    expect(html).not.toContain('<img')
    expect(html).toContain('«&lt;img src=x&gt;»')
  })
})
