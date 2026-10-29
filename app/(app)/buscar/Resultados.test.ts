import { beforeEach, describe, expect, it, vi } from 'vitest'

// The search, the almacenes and the scope of Pendientes are replaced: what is tested is what the screen makes of them.
vi.mock('@/lib/busqueda/paquetes', () => ({ buscarPaquetes: vi.fn() }))
vi.mock('@/lib/almacen-activo', () => ({ getAlmacenActivo: vi.fn() }))
vi.mock('@/lib/sync/pendientes', () => ({ alcanceDelOperario: vi.fn() }))

import { renderToStaticMarkup } from 'react-dom/server'
import type { Almacen, Operario } from '@/db/schema'
import { getAlmacenActivo } from '@/lib/almacen-activo'
import {
  buscarPaquetes, type BusquedaDePaquetes, type LugarOdoo, type LugarRecepcion, type PaqueteEncontrado,
} from '@/lib/busqueda/paquetes'
import { alcanceDelOperario } from '@/lib/sync/pendientes'
import { Resultados } from './Resultados'

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario
const mb92 = { id: 1, prefijo: 'MB92' } as Almacen

const recepcion = (datos: Partial<LugarRecepcion> = {}): LugarRecepcion => ({
  tipo: 'recepcion', trackingNumber: 'JJD000390007840588', almacenId: 1, almacenPrefijo: 'MB92', barcoOdooId: 673,
  barcoNombre: 'MAYANQUEEN', fecha: new Date('2026-10-28T09:32:00Z'), sesionId: 's1', estado: 'ok', odooPickingRef: 'MB92/IN/00231',
  operarioNombre: 'Veronika', duplicado: false, duplicadoRef: null, ...datos,
})

const esperandoEntrega = (datos: Partial<LugarOdoo> = {}): LugarOdoo => ({
  tipo: 'odoo', trackingNumber: 'JJD000390007840588', almacenId: 1, almacenPrefijo: 'MB92', barcoOdooId: 673,
  barcoNombre: 'MAYANQUEEN', fecha: new Date('2026-10-28T09:40:00Z'), operacion: 'entrega', hecho: false,
  pickingRef: 'MB92/OUT/00487', recibidoPor: null, ...datos,
})

const paquete = (datos: Partial<PaqueteEncontrado> = {}): PaqueteEncontrado => ({
  trackingNumber: 'JJD000390007840588', courierNombre: 'DHL', lugares: [recepcion(), esperandoEntrega()], ...datos,
})

function encontrado(busqueda: Partial<BusquedaDePaquetes>) {
  vi.mocked(buscarPaquetes).mockResolvedValue({ paquetes: [], hayMas: false, odooFallo: null, ...busqueda })
}

/** The results as the browser is given them. */
const dibujar = async (escrito = '0588') =>
  renderToStaticMarkup(await Resultados({ buscado: escrito.replace(/\s+/g, '').toLowerCase(), escrito, operario }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getAlmacenActivo).mockResolvedValue({ activo: mb92, disponibles: [mb92] })
  vi.mocked(alcanceDelOperario).mockResolvedValue({ almacenIds: [1] })
  encontrado({ paquetes: [paquete()] })
})

describe('Resultados', () => {
  it('searches what it is given, with the almacenes of the operario and the reach of their Pendientes', async () => {
    await dibujar()

    expect(buscarPaquetes).toHaveBeenCalledWith('0588')
    expect(getAlmacenActivo).toHaveBeenCalledWith('operario-1')
    expect(alcanceDelOperario).toHaveBeenCalledWith(operario)
  })

  it('shows each package with its courier and its places, in their order, saying what happened and how it is going', async () => {
    const html = await dibujar()

    expect(html).toContain('1 paquete con «0588»')
    expect(html).toContain('JJD000390007840588')
    expect(html).toContain('DHL')
    expect(html.indexOf('Recibido')).toBeLessThan(html.indexOf('Esperando entrega'))
    expect(html).toContain('✓ MB92/IN/00231')
    expect(html).toContain('MB92 · MAYANQUEEN · 28/10 10:32 · Veronika')
    expect(html).toContain('class="busqueda-lugar-estado busqueda-lugar-en_curso">MB92/OUT/00487')
  })

  it('opens what the operario may open, filtered by the package, and nothing else', async () => {
    encontrado({
      paquetes: [paquete({
        lugares: [recepcion(), recepcion({ sesionId: 's2', almacenId: 7, almacenPrefijo: 'IBZ' }), esperandoEntrega(), esperandoEntrega({ almacenId: 7 })],
      })],
    })

    const html = await dibujar()

    expect(html).toContain('href="/recepcion/s1?q=JJD000390007840588"')
    expect(html).toContain('href="/entrega/673?q=JJD000390007840588"')
    // The other almacén is told, with no way in.
    expect(html).toContain('IBZ · MAYANQUEEN')
    expect(html).not.toContain('/recepcion/s2')
    expect(html.match(/busqueda-lugar-enlace/g)).toHaveLength(2)
  })

  it('opens the delivery waiting only in the almacén Entrega works in', async () => {
    const ibz = { id: 7, prefijo: 'IBZ' } as Almacen
    vi.mocked(getAlmacenActivo).mockResolvedValue({ activo: ibz, disponibles: [mb92, ibz] })

    const html = await dibujar()

    expect(html).not.toContain('/entrega/673')
    expect(html).toContain('href="/recepcion/s1?q=JJD000390007840588"')
  })

  it('takes a problem to Pendientes, for the admin from any almacén', async () => {
    vi.mocked(alcanceDelOperario).mockResolvedValue('todos')
    encontrado({ paquetes: [paquete({ lugares: [recepcion({ estado: 'problema', almacenId: 7, almacenPrefijo: 'IBZ' })] })] })

    expect(await dibujar()).toContain('href="/pendientes?q=JJD000390007840588"')
  })

  it('says when Odoo could not be read, and that what is shown is only the webapp', async () => {
    encontrado({ paquetes: [paquete({ lugares: [recepcion()] })], odooFallo: 'No se pudo leer de Odoo. Probá de nuevo en un rato.' })

    const html = await dibujar()

    expect(html).toContain('No se pudo leer de Odoo. Probá de nuevo en un rato. Abajo está solo lo que tiene la webapp.')
    expect(html).toContain('JJD000390007840588')
  })

  it('says that no package has it, in the webapp or in Odoo, as it was typed', async () => {
    encontrado({ paquetes: [] })

    expect(await dibujar('99 99')).toContain('Ningún paquete tiene «99 99» en el tracking, ni en la webapp ni en Odoo.')
  })

  it('says that no package has it in the webapp when Odoo could not be read: it may be there', async () => {
    encontrado({ paquetes: [], odooFallo: 'No se pudo leer de Odoo. Probá de nuevo en un rato.' })

    expect(await dibujar()).toContain('Ningún paquete tiene «0588» en el tracking en la webapp.')
  })

  it('says when there are more than it shows', async () => {
    encontrado({ paquetes: [paquete()], hayMas: true })

    expect(await dibujar()).toContain('Hay más resultados: escribí más del número.')
  })

  it('does not let what was typed or a code act as HTML', async () => {
    encontrado({ paquetes: [paquete({ trackingNumber: '<img src=x>', lugares: [recepcion({ trackingNumber: '<img src=x>' })] })] })

    const html = await dibujar('<img src=x>')

    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x&gt;')
  })
})
