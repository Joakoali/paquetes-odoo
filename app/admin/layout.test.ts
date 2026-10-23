import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireAdminFromCookies: vi.fn() }))
vi.mock('@/components/app-shell', () => ({ AppShell: vi.fn() }))

import type { ReactElement } from 'react'
import { redirect } from 'next/navigation'
import { AppShell, type Tab } from '@/components/app-shell'
import type { Operario } from '@/db/schema'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/guards'
import AdminLayout from './layout'

const admin = { id: 'admin-1', nombre: 'Joaquín', rol: 'admin' } as Operario

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireAdminFromCookies).mockResolvedValue(admin)
  vi.mocked(redirect).mockImplementation((destino) => {
    throw new Error(`NEXT_REDIRECT ${destino}`)
  })
})

describe('admin layout', () => {
  it('sends whoever has no valid session to the login', async () => {
    vi.mocked(requireAdminFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

    await expect(AdminLayout({ children: 'PANTALLA' })).rejects.toThrow('NEXT_REDIRECT /login')
  })

  it('sends an operario who is not admin back to the app', async () => {
    vi.mocked(requireAdminFromCookies).mockRejectedValue(new ForbiddenError('Requires admin role'))

    await expect(AdminLayout({ children: 'PANTALLA' })).rejects.toThrow('NEXT_REDIRECT /recepcion')
  })

  it('puts the screen in the shell with the tabs of the admin: back to the app, Operarios, Datos de Odoo', async () => {
    const shell = (await AdminLayout({ children: 'PANTALLA' })) as ReactElement<{
      tabs: Tab[]
      almacenes?: unknown
      operarioNombre: string
      children: unknown
    }>

    expect(shell.type).toBe(AppShell)
    expect(shell.props.tabs).toEqual([
      { href: '/recepcion', label: '← Recepción' },
      { href: '/admin/operarios', label: 'Operarios' },
      { href: '/admin', label: 'Datos de Odoo' },
    ])
    expect(shell.props.operarioNombre).toBe('Joaquín')
    expect(shell.props.children).toBe('PANTALLA')
    // The admin screens do not depend on an almacén, so the bar has none.
    expect(shell.props.almacenes).toBeUndefined()
  })
})
