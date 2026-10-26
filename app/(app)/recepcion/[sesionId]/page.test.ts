import { beforeEach, describe, expect, it, vi } from 'vitest'

// What reaches the database, the session or the browser is replaced: what is tested is what the page decides.
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/admin/operarioAlmacenes', () => ({ operarioHasAlmacen: vi.fn() }))
vi.mock('@/lib/recepcion/recepciones', () => ({ getRecepcion: vi.fn() }))
vi.mock('@/lib/recepcion/couriers', () => ({ getCouriersParaRecepcion: vi.fn() }))
vi.mock('./RecepcionBarco', () => ({ RecepcionBarco: vi.fn() }))

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { notFound, redirect } from 'next/navigation'
import type { Operario } from '@/db/schema'
import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { getCouriersParaRecepcion } from '@/lib/recepcion/couriers'
import { getRecepcion, type RecepcionDetalle } from '@/lib/recepcion/recepciones'
import RecepcionBarcoPage from './page'
import { RecepcionBarco } from './RecepcionBarco'

const SESION = '5f0c7a9e-3b1d-4c55-9a52-0d9a3c1e7b10'

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario
const admin = { id: 'admin-1', nombre: 'Joaquín', rol: 'admin' } as Operario

const couriers = { frecuentes: [{ id: 1, nombre: 'DHL' }], todos: [{ id: 1, nombre: 'DHL' }, { id: 2, nombre: 'UPS' }] }

function recepcion(datos: Partial<RecepcionDetalle> = {}): RecepcionDetalle {
  return {
    id: SESION, almacenId: 4, almacenPrefijo: 'MAD1', barcoOdooId: 77, barcoNombre: 'MAYANQUEEN', estado: 'en_curso', paquetes: [], ...datos,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(operario)
  vi.mocked(operarioHasAlmacen).mockResolvedValue(true)
  vi.mocked(getRecepcion).mockResolvedValue(recepcion())
  vi.mocked(getCouriersParaRecepcion).mockResolvedValue(couriers)
  vi.mocked(notFound).mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND')
  })
  vi.mocked(redirect).mockImplementation((destino) => {
    throw new Error(`NEXT_REDIRECT ${destino}`)
  })
})

/** The page for the id that is in the address bar. Next hands the params as a promise. */
const pagina = (sesionId = SESION) => RecepcionBarcoPage({ params: Promise.resolve({ sesionId }) })

/** The first element of the tree that is of this type, or undefined. */
function buscar(nodo: ReactNode, tipo: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(nodo)) return nodo.map((hijo) => buscar(hijo, tipo)).find((encontrado) => encontrado !== undefined)
  if (!isValidElement<Record<string, unknown>>(nodo)) return undefined
  if (nodo.type === tipo) return nodo
  return buscar(nodo.props.children as ReactNode, tipo)
}

describe('RecepcionBarcoPage', () => {
  describe('who may see it', () => {
    it('sends whoever has no valid session to the login, without reading anything', async () => {
      vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

      await expect(pagina()).rejects.toThrow('NEXT_REDIRECT /login')

      expect(getRecepcion).not.toHaveBeenCalled()
    })

    it('is not found when there is no such recepción', async () => {
      vi.mocked(getRecepcion).mockResolvedValue(null)

      await expect(pagina('no-es-un-id')).rejects.toThrow('NEXT_NOT_FOUND')

      expect(getRecepcion).toHaveBeenCalledWith('no-es-un-id')
      expect(getCouriersParaRecepcion).not.toHaveBeenCalled()
    })

    it('is not found for an operario who does not have the almacén of the recepción, and reads nothing else', async () => {
      vi.mocked(operarioHasAlmacen).mockResolvedValue(false)

      await expect(pagina()).rejects.toThrow('NEXT_NOT_FOUND')

      expect(operarioHasAlmacen).toHaveBeenCalledWith('operario-1', 4)
      expect(getCouriersParaRecepcion).not.toHaveBeenCalled()
    })

    it('is the same "not found" for a recepción that exists and one that does not: the address says nothing', async () => {
      vi.mocked(operarioHasAlmacen).mockResolvedValue(false)
      const sinAcceso = await pagina().catch((error: Error) => error.message)
      vi.mocked(getRecepcion).mockResolvedValue(null)
      const inexistente = await pagina().catch((error: Error) => error.message)

      expect(sinAcceso).toBe(inexistente)
    })

    it('shows it to an operario who has the almacén', async () => {
      await pagina()

      expect(operarioHasAlmacen).toHaveBeenCalledWith('operario-1', 4)
    })

    it('is not found for an admin who does not have the almacén either: the actions would refuse them everything', async () => {
      vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)
      vi.mocked(operarioHasAlmacen).mockResolvedValue(false)

      await expect(pagina()).rejects.toThrow('NEXT_NOT_FOUND')

      expect(operarioHasAlmacen).toHaveBeenCalledWith('admin-1', 4)
      expect(getCouriersParaRecepcion).not.toHaveBeenCalled()
    })

    it('shows it to an admin who has the almacén, as to anybody else', async () => {
      vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)

      const resultado = await pagina()

      expect(operarioHasAlmacen).toHaveBeenCalledWith('admin-1', 4)
      expect(buscar(resultado, RecepcionBarco)).toBeDefined()
    })
  })

  describe('an open recepción', () => {
    it('is the screen of the barco, with the recepción and the couriers of its almacén', async () => {
      const abierta = recepcion({ almacenId: 9 })
      vi.mocked(getRecepcion).mockResolvedValue(abierta)

      const pantalla = buscar(await pagina(), RecepcionBarco)

      expect(getCouriersParaRecepcion).toHaveBeenCalledWith(9)
      expect(pantalla?.props.recepcion).toBe(abierta)
      expect(pantalla?.props.couriers).toBe(couriers)
    })

    it('is a screen of its own for each recepción, so that nothing of the one before stays in it', async () => {
      const pantalla = buscar(await pagina(), RecepcionBarco)

      expect(pantalla?.key).toBe(SESION)
    })
  })

  describe('a recepción that is not open any more', () => {
    beforeEach(() => {
      vi.mocked(getRecepcion).mockResolvedValue(recepcion({
        estado: 'sincronizada',
        paquetes: [
          { id: 'i2', trackingNumber: 'JJD000390007840588', courierId: 1, courierNombre: 'DHL', estado: 'ok', duplicadoRef: null },
          { id: 'i1', trackingNumber: 'JJD000390007711236', courierId: 1, courierNombre: 'DHL', estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' },
        ],
      }))
    })

    it('says it was sent and goes back to Recepción, without the screen to scan', async () => {
      const resultado = await pagina()
      const html = renderToStaticMarkup(resultado)

      expect(buscar(resultado, RecepcionBarco)).toBeUndefined()
      expect(html).toContain('Esta recepción ya se envió.')
      expect(html).toContain('MAYANQUEEN')
      expect(html).toContain('MAD1')
      expect(html).toMatch(/<a[^>]*href="\/recepcion"/)
    })

    it('shows what it had, to be read and nothing else', async () => {
      const html = renderToStaticMarkup(await pagina())

      expect(html).toContain('JJD000390007840588')
      expect(html).toContain('JJD000390007711236')
      expect(html).toContain('MB92/IN/00198')
      expect(html).not.toContain('<button')
      expect(html).not.toContain('<input')
    })

    it('does not look for couriers', async () => {
      await pagina()

      expect(getCouriersParaRecepcion).not.toHaveBeenCalled()
    })

    it('is for whoever has the almacén, as an open one is', async () => {
      vi.mocked(operarioHasAlmacen).mockResolvedValue(false)

      await expect(pagina()).rejects.toThrow('NEXT_NOT_FOUND')
    })

    it('does not let a code act as HTML', async () => {
      vi.mocked(getRecepcion).mockResolvedValue(recepcion({
        estado: 'sincronizada',
        paquetes: [{ id: 'i1', trackingNumber: '<img src=x onerror=alert(1)>', courierId: 1, courierNombre: 'DHL', estado: 'ok', duplicadoRef: null }],
      }))

      const html = renderToStaticMarkup(await pagina())

      expect(html).not.toContain('<img')
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    })
  })
})
