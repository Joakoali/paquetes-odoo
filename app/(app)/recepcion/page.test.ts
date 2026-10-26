import { beforeEach, describe, expect, it, vi } from 'vitest'

// What reaches the database, the session or the browser is replaced: what is tested is what the page decides.
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/almacen-activo', () => ({ requireAlmacenActivo: vi.fn() }))
vi.mock('@/lib/recepcion/recepciones', () => ({ listarRecepcionesAbiertas: vi.fn(), listarEnviadasHoy: vi.fn() }))
vi.mock('@/lib/recepcion/couriers', () => ({ getCouriersParaRecepcion: vi.fn() }))
vi.mock('./RecepcionHome', () => ({ RecepcionHome: vi.fn() }))

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { redirect } from 'next/navigation'
import type { Almacen, Operario } from '@/db/schema'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { ErrorParaOperario } from '@/lib/errores'
import { getCouriersParaRecepcion } from '@/lib/recepcion/couriers'
import { listarEnviadasHoy, listarRecepcionesAbiertas } from '@/lib/recepcion/recepciones'
import RecepcionPage from './page'
import { RecepcionHome } from './RecepcionHome'

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario
const almacen = { id: 4, prefijo: 'MB92' } as Almacen

const abiertas = [{
  id: 'r1', barcoOdooId: 7, barcoNombre: 'MAYANQUEEN', paquetes: 3, duplicados: 0,
  porCourier: [{ nombre: 'DHL', cantidad: 3 }], abiertaDesde: new Date('2026-10-26T09:12:00Z'),
}]
const enviadas = [{
  id: 'r2', barcoNombre: 'ARCTIC', paquetes: 4, estado: 'ok' as const, odooPickingRef: 'MB92/IN/00231',
  enviadaAt: new Date('2026-10-26T08:00:00Z'),
}]
const couriers = { frecuentes: [{ id: 1, nombre: 'DHL' }], todos: [{ id: 1, nombre: 'DHL' }, { id: 2, nombre: 'UPS' }] }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(operario)
  vi.mocked(requireAlmacenActivo).mockResolvedValue(almacen)
  vi.mocked(listarRecepcionesAbiertas).mockResolvedValue(abiertas)
  vi.mocked(listarEnviadasHoy).mockResolvedValue(enviadas)
  vi.mocked(getCouriersParaRecepcion).mockResolvedValue(couriers)
  vi.mocked(redirect).mockImplementation((destino) => {
    throw new Error(`NEXT_REDIRECT ${destino}`)
  })
})

/** The first element of the tree that is of this type, or undefined. */
function buscar(nodo: ReactNode, tipo: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(nodo)) return nodo.map((hijo) => buscar(hijo, tipo)).find((encontrado) => encontrado !== undefined)
  if (!isValidElement<Record<string, unknown>>(nodo)) return undefined
  if (nodo.type === tipo) return nodo
  return buscar(nodo.props.children as ReactNode, tipo)
}

describe('RecepcionPage', () => {
  it('sends whoever has no valid session to the login, without reading anything', async () => {
    vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

    await expect(RecepcionPage()).rejects.toThrow('NEXT_REDIRECT /login')

    expect(requireAlmacenActivo).not.toHaveBeenCalled()
    expect(listarRecepcionesAbiertas).not.toHaveBeenCalled()
  })

  it('says it in a warning, and reads nothing, when the operario has no almacén', async () => {
    vi.mocked(requireAlmacenActivo).mockRejectedValue(new ErrorParaOperario('No tenés almacenes asignados. Avisá al admin.'))

    const html = renderToStaticMarkup((await RecepcionPage()) as ReactElement)

    expect(html).toContain('<p class="banner banner-warn">No tenés almacenes asignados. Avisá al admin.</p>')
    expect(listarRecepcionesAbiertas).not.toHaveBeenCalled()
    expect(listarEnviadasHoy).not.toHaveBeenCalled()
    expect(getCouriersParaRecepcion).not.toHaveBeenCalled()
  })

  it('does not hide what is not an answer for the operario (the database down) behind that warning', async () => {
    vi.mocked(requireAlmacenActivo).mockRejectedValue(new Error('connection refused'))

    await expect(RecepcionPage()).rejects.toThrow('connection refused')
  })

  it('reads the open and the sent-today recepciones and the couriers of the active almacén', async () => {
    await RecepcionPage()

    expect(requireAlmacenActivo).toHaveBeenCalledWith('operario-1')
    expect(listarRecepcionesAbiertas).toHaveBeenCalledWith(4)
    expect(listarEnviadasHoy).toHaveBeenCalledWith(4)
    expect(getCouriersParaRecepcion).toHaveBeenCalledWith(4)
  })

  it('draws the home with what it read, and the time it was read at', async () => {
    const antes = Date.now()
    const pagina = await RecepcionPage()
    const despues = Date.now()

    const home = buscar(pagina, RecepcionHome)
    expect(home?.props).toMatchObject({ abiertas, enviadas, couriers })
    const ahora = home?.props.ahora
    expect(ahora).toBeInstanceOf(Date)
    expect((ahora as Date).getTime()).toBeGreaterThanOrEqual(antes)
    expect((ahora as Date).getTime()).toBeLessThanOrEqual(despues)
  })
})
