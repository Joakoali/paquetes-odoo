import { describe, expect, it, vi } from 'vitest'

// The router and the actions are only reached by touching the screen; what is tested is the screen as it is first drawn.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock('../actions', () => ({ confirmarEntregaAction: vi.fn(), enviarRecepcionesDelBarcoAction: vi.fn() }))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LineaEntrega } from '@/lib/odoo/pickings'
import { EntregaFlow } from './EntregaFlow'

const linea = (moveLineId: number, trackingNumber: string | null): LineaEntrega => ({
  moveLineId, pickingId: 700, pickingRef: 'MB92/OUT/00487', trackingNumber, courierNombre: 'DHL',
})

/** Seven lines: two end in 0588, and one has no number. */
const siete = [
  linea(1, 'JJD000390007840588'), linea(2, 'JJD000390007711236'), linea(3, '1Z999AA10123450588'), linea(4, null),
  linea(5, 'XW297134737JF'), linea(6, 'JJD000390007700001'), linea(7, 'JJD000390007700002'),
]

/** The list of packages of the barco as the phone is first given it. */
const dibujar = (lineas: LineaEntrega[], filtroInicial = '') => renderToStaticMarkup(createElement(EntregaFlow, {
  barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', almacenPrefijo: 'MB92', lineas, sinEnviar: 0, enviandose: 0, filtroInicial,
}))

describe('EntregaFlow, the filter by tracking number', () => {
  it('is not there for a few packages, which are read at a glance', () => {
    const html = dibujar(siete.slice(0, 5))

    expect(html).not.toContain('Filtrar por tracking nº')
    expect(html.match(/role="checkbox"/g)).toHaveLength(5)
  })

  it('is there from six packages, with every one of them in view while nothing is typed', () => {
    const html = dibujar(siete)

    expect(html).toContain('aria-label="Filtrar por tracking nº"')
    expect(html.match(/role="checkbox"/g)).toHaveLength(7)
  })

  it('opens with the filter it is given, showing only the packages that have it', () => {
    const html = dibujar(siete, '0588')

    expect(html.match(/role="checkbox"/g)).toHaveLength(2)
    expect(html).toContain('JJD000390007840588')
    expect(html).toContain('1Z999AA10123450588')
    expect(html).not.toContain('JJD000390007711236')
    expect(html).toContain('Mostrando 2 de 7')
  })

  it('only hides rows: what is chosen, counted and signed for is every package, the hidden ones too', () => {
    const html = dibujar(siete, '0588')

    expect(html).toContain('Se entregan 7 de 7')
    expect(html).toContain('Siguiente: firma · 7 paquetes')
  })

  it('opens filtered however short the list is, so that the filter it came with can be taken away', () => {
    const html = dibujar(siete.slice(0, 2), '0588')

    expect(html).toContain('aria-label="Filtrar por tracking nº"')
    expect(html).toContain('Mostrando 1 de 2')
  })

  it('draws no list, only what the filter says, when no package has what it opened with', () => {
    const html = dibujar(siete, '9999')

    expect(html).not.toContain('role="checkbox"')
    expect(html).toContain('Ningún paquete tiene «9999» en el tracking.')
    // Nothing was taken out of the delivery by filtering.
    expect(html).toContain('Siguiente: firma · 7 paquetes')
  })
})
