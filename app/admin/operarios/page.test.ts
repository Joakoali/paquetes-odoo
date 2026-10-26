import { beforeEach, describe, expect, it, vi } from 'vitest'

// What reaches the database or the session is replaced: what is tested is what the page shows.
vi.mock('@/lib/auth/current-operario', () => ({ requireAdminFromCookies: vi.fn() }))
vi.mock('@/lib/admin/operarios', () => ({ listOperariosConAlmacenes: vi.fn() }))
vi.mock('./actions', () => ({ createOperarioAction: vi.fn(), toggleOperarioActivoAction: vi.fn() }))

import { renderToStaticMarkup } from 'react-dom/server'
import type { Operario } from '@/db/schema'
import { listOperariosConAlmacenes } from '@/lib/admin/operarios'
import { ForbiddenError } from '@/lib/auth/guards'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import OperariosAdminPage from './page'

const operario = (datos: Partial<Operario> & { almacenes?: string[] }) => ({
  id: 'op-1',
  nombre: 'Veronika',
  login: 'vero',
  passwordHash: 'hash-que-no-se-ve',
  rol: 'operario' as const,
  activo: true,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  almacenes: [],
  ...datos,
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireAdminFromCookies).mockResolvedValue({ id: 'admin-1', rol: 'admin' } as Operario)
  vi.mocked(listOperariosConAlmacenes).mockResolvedValue([])
})

/** The page as the browser will be given it, as HTML. */
async function html(...operarios: Array<ReturnType<typeof operario>>): Promise<string> {
  vi.mocked(listOperariosConAlmacenes).mockResolvedValue(operarios)
  return renderToStaticMarkup(await OperariosAdminPage())
}

describe('OperariosAdminPage', () => {
  it('shows each operario with their user, their role, whether they are active and their almacenes', async () => {
    const pagina = await html(
      operario({ id: 'op-1', nombre: 'Veronika', login: 'vero', almacenes: ['MB92', 'MPV'] }),
      operario({ id: 'op-2', nombre: 'Joaquín', login: 'joaquin', rol: 'admin', activo: false }),
    )

    expect(pagina).toContain('Veronika')
    expect(pagina).toContain('vero')
    expect(pagina).toContain('MB92, MPV')
    expect(pagina).toContain('Joaquín')
    expect(pagina).toContain('Admin')
    expect(pagina).toContain('Inactivo')
    expect(pagina).toContain('Sin almacenes asignados')
  })

  it('links each operario to the screen of their almacenes', async () => {
    const pagina = await html(operario({ id: 'op-7' }))

    expect(pagina).toContain('href="/admin/operarios/op-7/almacenes"')
  })

  it('has the form that creates an operario', async () => {
    const pagina = await html()

    expect(pagina).toContain('Nuevo operario')
    expect(pagina).toContain('name="login"')
    expect(pagina).toContain('type="password"')
  })

  it('never puts the password hash on the page', async () => {
    expect(await html(operario({}))).not.toContain('hash-que-no-se-ve')
  })

  it('shows nothing to whoever is not an admin', async () => {
    vi.mocked(requireAdminFromCookies).mockRejectedValue(new ForbiddenError('Admin role required'))

    await expect(OperariosAdminPage()).rejects.toBeInstanceOf(ForbiddenError)

    expect(listOperariosConAlmacenes).not.toHaveBeenCalled()
  })
})
