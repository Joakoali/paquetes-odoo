import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BarcoParaEntregar } from '@/lib/entrega/entregas'
import { ListaBarcos } from './ListaBarcos'

const AHORA = new Date('2026-10-23T12:00:00.000Z')

function barco(datos: Partial<BarcoParaEntregar> & Pick<BarcoParaEntregar, 'barcoOdooId' | 'barcoNombre'>): BarcoParaEntregar {
  return {
    barcoEtiqueta: datos.barcoNombre,
    paquetes: 2,
    desde: new Date('2026-10-22T09:00:00.000Z'),
    sinEnviar: 0,
    ...datos,
  }
}

/** The list as the browser is first given it, with nothing typed in the filter yet. */
const dibujar = (barcos: BarcoParaEntregar[]) =>
  renderToStaticMarkup(createElement(ListaBarcos, { barcos, almacenPrefijo: 'MB92', ahora: AHORA }))

describe('ListaBarcos', () => {
  it('says each barco by its label, so that two with the same name can be told apart', () => {
    const html = dibujar([
      barco({ barcoOdooId: 1234, barcoNombre: 'H3', barcoEtiqueta: 'H3 · #1234' }),
      barco({ barcoOdooId: 1301, barcoNombre: 'H3', barcoEtiqueta: 'H3 · #1301' }),
      barco({ barcoOdooId: 673, barcoNombre: 'MAYANQUEEN' }),
    ])

    expect(html).toContain('H3 · #1234')
    expect(html).toContain('H3 · #1301')
    expect(html.match(/class="fila-nombre"/g)).toHaveLength(3)
    expect(html).toMatch(/<span class="fila-nombre">MAYANQUEEN<\/span>/)
    // Each opens its own barco, whatever it is called.
    expect(html).toContain('href="/entrega/1234"')
    expect(html).toContain('href="/entrega/1301"')
  })
})
