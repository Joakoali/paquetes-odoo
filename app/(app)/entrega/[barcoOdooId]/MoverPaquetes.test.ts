import { describe, expect, it, vi } from 'vitest'

// The router and the action are only reached by touching the screen; what is tested is the screen as it is first drawn.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock('../actions', () => ({ moverPaquetesAction: vi.fn() }))
vi.mock('@/app/(app)/barcos-actions', () => ({ searchBarcosAction: vi.fn() }))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LineaEntrega } from '@/lib/odoo/pickings'
import { MoverPaquetes } from './MoverPaquetes'

const linea = (moveLineId: number, trackingNumber: string | null): LineaEntrega => ({
  moveLineId, pickingId: 700, pickingRef: 'MB92/OUT/00487', trackingNumber, courierNombre: 'DHL',
})

const seis = [
  linea(1, 'JJD000390007840588'), linea(2, 'JJD000390007711236'), linea(3, '1Z999AA10123450588'), linea(4, null),
  linea(5, 'XW297134737JF'), linea(6, 'JJD000390007700001'),
]

const dibujar = (lineas: LineaEntrega[], filtroInicial = '') => renderToStaticMarkup(createElement(MoverPaquetes, {
  barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', almacenPrefijo: 'MB92', lineas, filtroInicial, onVolver: vi.fn(),
}))

describe('MoverPaquetes, as it opens', () => {
  it('lists every package of the barco with none chosen: what goes is what the operario picks', () => {
    const html = dibujar(seis)

    expect(html.match(/role="checkbox"/g)).toHaveLength(6)
    expect(html).not.toContain('aria-checked="true"')
    expect(html).toContain('Se mueven 0 de 6')
    expect(html).not.toContain('en depósito')
  })

  it('cannot go on to choose the barco until a package is chosen', () => {
    const html = dibujar(seis)

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Elegí al menos un paquete<\/button>/)
  })

  it('opens filtered by what the delivery was filtered by, which may be how the package was found', () => {
    const html = dibujar(seis, '0588')

    expect(html.match(/role="checkbox"/g)).toHaveLength(2)
    expect(html).toContain('Mostrando 2 de 6')
  })

  it('names the barco and the almacén the packages are taken from', () => {
    const html = dibujar(seis)

    expect(html).toContain('MAYANQUEEN')
    expect(html).toContain('MB92')
    expect(html).toContain('‹ Cancelar')
  })
})
