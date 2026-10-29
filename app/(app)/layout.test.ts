import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/almacen-activo', () => ({ getAlmacenActivo: vi.fn() }))
vi.mock('@/lib/sync/pendientes', () => ({ alcanceDelOperario: vi.fn(), contarProblemas: vi.fn() }))
vi.mock('@/components/app-shell', () => ({ AppShell: vi.fn() }))

import type { ReactElement } from 'react'
import { redirect } from 'next/navigation'
import { AppShell, type Tab } from '@/components/app-shell'
import type { Almacen, Operario } from '@/db/schema'
import { getAlmacenActivo, type AlmacenesDelOperario } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { alcanceDelOperario, contarProblemas } from '@/lib/sync/pendientes'
import AppLayout from './layout'

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario
const admin = { id: 'admin-1', nombre: 'Joaquín', rol: 'admin' } as Operario
const mb92 = { id: 1, prefijo: 'MB92', nombre: 'Barcelona (MB92)' } as Almacen
const almacenes: AlmacenesDelOperario = { activo: mb92, disponibles: [mb92] }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(operario)
  vi.mocked(getAlmacenActivo).mockResolvedValue(almacenes)
  vi.mocked(alcanceDelOperario).mockResolvedValue({ almacenIds: [1] })
  vi.mocked(contarProblemas).mockResolvedValue(0)
  vi.mocked(redirect).mockImplementation((destino) => {
    throw new Error(`NEXT_REDIRECT ${destino}`)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface PropsDelShell {
  tabs: Tab[]
  almacenes?: AlmacenesDelOperario
  operarioNombre: string
  children: unknown
}

/** What the layout hands to the shell. The shell itself is tested on its own, drawn. */
async function elShell(): Promise<ReactElement<PropsDelShell>> {
  const resultado = (await AppLayout({ children: 'PANTALLA' })) as ReactElement<PropsDelShell>
  expect(resultado.type).toBe(AppShell)
  return resultado
}

describe('(app) layout', () => {
  it('sends whoever has no valid session to the login, without reading anything else', async () => {
    vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

    await expect(AppLayout({ children: 'PANTALLA' })).rejects.toThrow('NEXT_REDIRECT /login')

    expect(getAlmacenActivo).not.toHaveBeenCalled()
    expect(contarProblemas).not.toHaveBeenCalled()
  })

  it('puts the screen in the shell, for the operario that is logged in', async () => {
    const shell = await elShell()

    expect(shell.props.operarioNombre).toBe('Veronika')
    expect(shell.props.children).toBe('PANTALLA')
  })

  describe('the tabs', () => {
    it('are Recepción, Entrega, Pendientes and Buscar for an operario, and no Admin', async () => {
      const { tabs } = (await elShell()).props

      expect(tabs.map((tab) => [tab.href, tab.label])).toEqual([
        ['/recepcion', 'Recepción'],
        ['/entrega', 'Entrega'],
        ['/pendientes', 'Pendientes'],
        ['/buscar', 'Buscar'],
      ])
    })

    it('have Admin last for the admin', async () => {
      vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)

      const { tabs } = (await elShell()).props

      expect(tabs.map((tab) => [tab.href, tab.label])).toEqual([
        ['/recepcion', 'Recepción'],
        ['/entrega', 'Entrega'],
        ['/pendientes', 'Pendientes'],
        ['/buscar', 'Buscar'],
        ['/admin', 'Admin'],
      ])
    })

    it('have the number of problems to look at on Pendientes, and on no other tab', async () => {
      vi.mocked(contarProblemas).mockResolvedValue(4)

      const { tabs } = (await elShell()).props

      expect(tabs.map((tab) => [tab.label, tab.badge])).toEqual([
        ['Recepción', undefined],
        ['Entrega', undefined],
        ['Pendientes', 4],
        ['Buscar', undefined],
      ])
    })

    it('count in the scope of the operario: what alcanceDelOperario says, never anything wider', async () => {
      vi.mocked(alcanceDelOperario).mockResolvedValue({ almacenIds: [1, 3] })

      await elShell()

      expect(alcanceDelOperario).toHaveBeenCalledWith(operario)
      expect(contarProblemas).toHaveBeenCalledTimes(1)
      expect(contarProblemas).toHaveBeenCalledWith({ almacenIds: [1, 3] })
    })

    it('count every almacén for the admin', async () => {
      vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)
      vi.mocked(alcanceDelOperario).mockResolvedValue('todos')

      await elShell()

      expect(alcanceDelOperario).toHaveBeenCalledWith(admin)
      expect(contarProblemas).toHaveBeenCalledWith('todos')
    })

    it('still draw when the problems cannot be counted: Pendientes just has no number', async () => {
      const consola = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(contarProblemas).mockRejectedValue(new Error('connection terminated'))

      const { tabs } = (await elShell()).props

      expect(tabs.find((tab) => tab.label === 'Pendientes')?.badge).toBeUndefined()
      expect(tabs).toHaveLength(4)
      // It is not hidden either: somebody reading the logs finds why.
      expect(consola).toHaveBeenCalledTimes(1)
    })

    it('still draw when the scope cannot be worked out', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(alcanceDelOperario).mockRejectedValue(new Error('connection terminated'))

      const { tabs } = (await elShell()).props

      expect(tabs.find((tab) => tab.label === 'Pendientes')?.badge).toBeUndefined()
      expect(contarProblemas).not.toHaveBeenCalled()
    })
  })

  describe('the almacén', () => {
    it('is the one getAlmacenActivo says for this operario, as it comes', async () => {
      const shell = await elShell()

      expect(getAlmacenActivo).toHaveBeenCalledWith('operario-1')
      expect(shell.props.almacenes).toBe(almacenes)
    })

    it('is read for the admin too, who also works in an almacén', async () => {
      vi.mocked(requireOperarioFromCookies).mockResolvedValue(admin)

      await elShell()

      expect(getAlmacenActivo).toHaveBeenCalledWith('admin-1')
    })
  })
})
