import { describe, expect, it, vi } from 'vitest'

// The router and the actions are only reached by scanning or touching; what is tested is the screen as it is first drawn.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../actions', () => ({
  borrarPaqueteAction: vi.fn(),
  descartarRecepcionAction: vi.fn(),
  descartarSiVaciaAction: vi.fn(),
  enviarRecepcionAction: vi.fn(),
  escanearAction: vi.fn(),
}))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PaqueteEscaneado, RecepcionDetalle } from '@/lib/recepcion/recepciones'
import { RecepcionBarco } from './RecepcionBarco'

const couriers = { frecuentes: [{ id: 1, nombre: 'DHL' }], todos: [{ id: 1, nombre: 'DHL' }] }

const paquete = (id: string, trackingNumber: string): PaqueteEscaneado => ({
  id, trackingNumber, courierId: 1, courierNombre: 'DHL', estado: 'ok', duplicadoRef: null,
})

/** The screen of an open recepción with these packages, as the tablet is first given it. */
const dibujar = (paquetes: PaqueteEscaneado[], filtroInicial = '') => {
  const recepcion: RecepcionDetalle = {
    id: '5f0c7a9e-3b1d-4c55-9a52-0d9a3c1e7b10', almacenId: 4, almacenPrefijo: 'MB92', barcoOdooId: 673, barcoNombre: 'MAYANQUEEN',
    estado: 'en_curso', paquetes,
  }
  return renderToStaticMarkup(createElement(RecepcionBarco, { recepcion, couriers, filtroInicial }))
}

describe('RecepcionBarco, the filter by tracking number', () => {
  it('is not there before the first package: there is nothing to filter', () => {
    const html = dibujar([])

    expect(html).not.toContain('Filtrar por tracking nº')
    expect(html).toContain('Todavía no escaneaste ningún paquete.')
  })

  it('is there from the first package, so that it does not show up halfway through a burst of the gun', () => {
    const html = dibujar([paquete('i1', 'JJD000390007840588')])

    expect(html).toContain('aria-label="Filtrar por tracking nº"')
  })

  it('does not take the focus from the scan field: only the scan field is there to have it', () => {
    const html = dibujar([paquete('i1', 'JJD000390007840588')], '0588')

    expect(html).not.toMatch(/<input[^>]*aria-label="Filtrar por tracking nº"[^>]*autofocus/i)
    expect(html).toContain('aria-label="Código del paquete"')
  })

  it('opens with the filter it is given, showing only the packages that have it and counting them all', () => {
    const html = dibujar([
      paquete('i3', 'JJD000390007840588'), paquete('i2', 'XW297134737JF'), paquete('i1', '1Z999AA10123456784'),
    ], '0588')

    expect(html).toContain('JJD000390007840588')
    expect(html).not.toContain('XW297134737JF')
    expect(html).not.toContain('1Z999AA10123456784')
    expect(html).toContain('Mostrando 1 de 3')
    expect(html).toContain('Paquetes · 3 escaneados')
  })

  it('says so when no package has what it opened with, with no list and the field to scan still there', () => {
    const html = dibujar([paquete('i1', 'JJD000390007840588')], '9999')

    expect(html).not.toContain('paquetes-lista')
    expect(html).toContain('Ningún paquete tiene «9999» en el tracking.')
    expect(html).toContain('aria-label="Código del paquete"')
  })

  it('is there when it opens with a filter on a recepción left empty meanwhile, so that it can be taken away', () => {
    const html = dibujar([], '0588')

    expect(html).toContain('aria-label="Filtrar por tracking nº"')
    expect(html).toContain('Todavía no escaneaste ningún paquete.')
  })
})
