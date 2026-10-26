import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// What reaches the database, the session or the queue is replaced: what is tested is what the page shows.
vi.mock('@/lib/auth/current-operario', () => ({ requireAdminFromCookies: vi.fn() }))
vi.mock('@/lib/maestros/refresh', () => ({ ultimoRefresco: vi.fn(), contarMaestrosActivos: vi.fn() }))
vi.mock('./actions', () => ({ refrescarDatosOdooAction: vi.fn() }))

import { renderToStaticMarkup } from 'react-dom/server'
import type { Operario } from '@/db/schema'
import { ForbiddenError } from '@/lib/auth/guards'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { contarMaestrosActivos, ultimoRefresco } from '@/lib/maestros/refresh'
import DatosDeOdooPage from './page'

/** The page reads the clock once: "hace 3 h" is counted from here. */
const AHORA = new Date('2026-10-26T12:00:00.000Z')

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(AHORA)
  vi.mocked(requireAdminFromCookies).mockResolvedValue({ id: 'admin-1', rol: 'admin' } as Operario)
  vi.mocked(ultimoRefresco).mockResolvedValue(new Date('2026-10-26T09:00:00.000Z'))
  vi.mocked(contarMaestrosActivos).mockResolvedValue({ almacenes: 4, couriers: 73 })
})

afterEach(() => {
  vi.useRealTimers()
})

/** The page as the browser will be given it, with the tags taken off so that the text reads in a line. */
async function texto(): Promise<string> {
  return renderToStaticMarkup(await DatosDeOdooPage()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

describe('DatosDeOdooPage', () => {
  it('says how long ago Odoo was last read, and how many almacenes and couriers are active', async () => {
    const pagina = await texto()

    expect(pagina).toContain('Datos de Odoo')
    expect(pagina).toContain('Último refresco hace 3 h')
    expect(pagina).toContain('Almacenes activos 4')
    expect(pagina).toContain('Couriers activos 73')
  })

  it('says "Nunca" while Odoo has not been read', async () => {
    vi.mocked(ultimoRefresco).mockResolvedValue(null)

    expect(await texto()).toContain('Último refresco Nunca')
  })

  it('has the button that refreshes it', async () => {
    expect(await texto()).toContain('Refrescar ahora')
  })

  it('shows nothing to whoever is not an admin', async () => {
    vi.mocked(requireAdminFromCookies).mockRejectedValue(new ForbiddenError('Admin role required'))

    await expect(DatosDeOdooPage()).rejects.toBeInstanceOf(ForbiddenError)

    expect(ultimoRefresco).not.toHaveBeenCalled()
    expect(contarMaestrosActivos).not.toHaveBeenCalled()
  })
})
