import { beforeEach, describe, expect, it, vi } from 'vitest'

// The shell is drawn here as the browser will be given it. What would reach the database or the server is replaced.
vi.mock('next/navigation', () => ({ usePathname: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/app/(auth)/logout/actions', () => ({ logout: vi.fn() }))
vi.mock('@/app/(app)/almacen-actions', () => ({ elegirAlmacenAction: vi.fn() }))

import { renderToStaticMarkup } from 'react-dom/server'
import { usePathname } from 'next/navigation'
import type { Almacen } from '@/db/schema'
import type { AlmacenesDelOperario } from '@/lib/almacen-activo'
import { AppShell, type Tab } from './app-shell'

const almacen = (datos: Pick<Almacen, 'id' | 'prefijo' | 'nombre'>): Almacen => ({
  odooInTypeId: 11, odooOutTypeId: 12, odooWarehouseId: 3, activo: true, ...datos,
})
const MB92 = almacen({ id: 1, prefijo: 'MB92', nombre: 'Barcelona (MB92)' })
const IBZ = almacen({ id: 2, prefijo: 'IBZ', nombre: 'Ibiza / Baleares' })

const TABS: Tab[] = [
  { href: '/recepcion', label: 'Recepción' },
  { href: '/entrega', label: 'Entrega' },
  { href: '/pendientes', label: 'Pendientes', badge: 3 },
]

function html(datos: { tabs?: Tab[]; almacenes?: AlmacenesDelOperario; operarioNombre?: string } = {}): string {
  return renderToStaticMarkup(AppShell({
    tabs: datos.tabs ?? TABS,
    almacenes: datos.almacenes,
    operarioNombre: datos.operarioNombre ?? 'Veronika',
    children: 'CONTENIDO',
  }))
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(usePathname).mockReturnValue('/recepcion')
})

describe('AppShell', () => {
  it('shows who is working, "Cerrar sesión" in a form, and the screen it was given', () => {
    const pagina = html({ operarioNombre: 'Veronika' })

    expect(pagina).toContain('Veronika')
    expect(pagina).toMatch(/<form[^>]*>.*<button[^>]*type="submit"[^>]*>Cerrar sesión<\/button><\/form>/)
    expect(pagina).toContain('CONTENIDO')
  })

  it('does not let the name of the operario act as HTML', () => {
    const pagina = html({ operarioNombre: '<img src=x onerror=alert(1)>' })

    expect(pagina).not.toContain('<img')
    expect(pagina).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  describe('the tabs', () => {
    it('are the ones it is given, in order, each going where it says', () => {
      const pagina = html()

      expect(pagina.match(/href="(\/[a-z]+)"/g)).toEqual(['href="/recepcion"', 'href="/entrega"', 'href="/pendientes"'])
      expect(pagina.indexOf('Recepción')).toBeLessThan(pagina.indexOf('Entrega'))
      expect(pagina.indexOf('Entrega')).toBeLessThan(pagina.indexOf('Pendientes'))
    })

    it('mark the one of the page that is open, and only that one', () => {
      vi.mocked(usePathname).mockReturnValue('/entrega/42')

      const pagina = html()

      expect(pagina.match(/aria-current="page"/g)).toHaveLength(1)
      expect(pagina).toMatch(/href="\/entrega"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/entrega"/)
    })

    it('mark none when the page is none of them', () => {
      vi.mocked(usePathname).mockReturnValue('/otra-cosa')

      expect(html()).not.toContain('aria-current')
    })

    it('say how many there are to resolve, but only when there is something', () => {
      expect(html()).toMatch(/Pendientes<span class="shell-tab-badge">3<\/span>/)
      expect(html({ tabs: [{ href: '/pendientes', label: 'Pendientes', badge: 0 }] })).not.toContain('shell-tab-badge')
      expect(html({ tabs: [{ href: '/pendientes', label: 'Pendientes' }] })).not.toContain('shell-tab-badge')
    })

    it('say 99+ when there are more than 99', () => {
      expect(html({ tabs: [{ href: '/pendientes', label: 'Pendientes', badge: 150 }] })).toContain('>99+<')
      expect(html({ tabs: [{ href: '/pendientes', label: 'Pendientes', badge: 99 }] })).toContain('>99<')
    })
  })

  describe('the almacén', () => {
    it('can be changed when the operario has more than one, and the select shows the one in use', () => {
      const pagina = html({ almacenes: { activo: IBZ, disponibles: [IBZ, MB92] } })

      expect(pagina).toContain('<select')
      expect(pagina).toMatch(/<option value="2" selected="">IBZ · Ibiza \/ Baleares<\/option>/)
      expect(pagina).toMatch(/<option value="1">MB92 · Barcelona \(MB92\)<\/option>/)
      // The pill, which is what is seen, says the same almacén as the select.
      expect(pagina).toMatch(/shell-almacen-pill[^>]*>IBZ/)
    })

    it('shows the almacén the server says is in use, never another of the list', () => {
      const primero = html({ almacenes: { activo: MB92, disponibles: [MB92, IBZ] } })
      const segundo = html({ almacenes: { activo: IBZ, disponibles: [MB92, IBZ] } })

      expect(primero).toMatch(/<option value="1" selected="">/)
      expect(primero).not.toMatch(/<option value="2" selected="">/)
      expect(segundo).toMatch(/<option value="2" selected="">/)
      expect(segundo).not.toMatch(/<option value="1" selected="">/)
    })

    it('is only said when the operario has just one: it cannot be changed', () => {
      const pagina = html({ almacenes: { activo: MB92, disponibles: [MB92] } })

      expect(pagina).toMatch(/shell-almacen-pill[^>]*>MB92</)
      expect(pagina).not.toContain('<select')
    })

    it('says there is none when the operario has no almacén', () => {
      const pagina = html({ almacenes: { activo: null, disponibles: [] } })

      expect(pagina).toContain('Sin almacén')
      expect(pagina).not.toContain('<select')
    })

    it('is not in the bar at all where the screens do not depend on one (the admin area)', () => {
      const pagina = html({ almacenes: undefined })

      expect(pagina).not.toContain('shell-almacen')
      expect(pagina).not.toContain('Sin almacén')
    })
  })
})
