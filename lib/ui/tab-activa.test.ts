import { describe, expect, it } from 'vitest'
import { tabActiva } from './tab-activa'

const APP = ['/recepcion', '/entrega', '/pendientes', '/admin']
const ADMIN = ['/recepcion', '/admin/operarios', '/admin']

describe('tabActiva', () => {
  it('is the tab whose page it is', () => {
    expect(tabActiva(APP, '/recepcion')).toBe('/recepcion')
    expect(tabActiva(APP, '/entrega')).toBe('/entrega')
    expect(tabActiva(APP, '/pendientes')).toBe('/pendientes')
  })

  it('keeps a tab active on the pages below it, such as the screen of one barco or one recepción', () => {
    expect(tabActiva(APP, '/recepcion/3f2c9a10')).toBe('/recepcion')
    expect(tabActiva(APP, '/entrega/42')).toBe('/entrega')
  })

  it('lights the longest match, so "Datos de Odoo" (/admin) does not take the pages of "Operarios" from it', () => {
    expect(tabActiva(ADMIN, '/admin')).toBe('/admin')
    expect(tabActiva(ADMIN, '/admin/operarios')).toBe('/admin/operarios')
    expect(tabActiva(ADMIN, '/admin/operarios/7/almacenes')).toBe('/admin/operarios')
  })

  it('does not depend on the order of the tabs', () => {
    expect(tabActiva([...ADMIN].reverse(), '/admin/operarios/7/almacenes')).toBe('/admin/operarios')
  })

  it('matches whole segments: /admin is not the start of /administrar', () => {
    expect(tabActiva(APP, '/administrar')).toBeNull()
    expect(tabActiva(APP, '/recepciones')).toBeNull()
  })

  it('is none when the page is not one of the tabs', () => {
    expect(tabActiva(APP, '/')).toBeNull()
    expect(tabActiva(APP, '/login')).toBeNull()
    expect(tabActiva([], '/recepcion')).toBeNull()
  })

  it('does not light the "← Recepción" tab of the admin on the admin pages', () => {
    expect(tabActiva(ADMIN, '/admin/mapeos')).toBe('/admin')
    expect(tabActiva(ADMIN, '/recepcion')).toBe('/recepcion')
  })
})
