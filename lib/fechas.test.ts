import { describe, it, expect } from 'vitest'
import { ZONA_HORARIA, formatFechaOdoo, parseFechaOdoo } from './fechas'

describe('fechas', () => {
  it('names the time zone the warehouses work in', () => {
    expect(ZONA_HORARIA).toBe('Europe/Madrid')
  })

  it('formatFechaOdoo writes UTC in Odoo format', () =>
    expect(formatFechaOdoo(new Date('2026-07-24T09:05:03Z'))).toBe('2026-07-24 09:05:03'))

  it('formatFechaOdoo converts an instant given with an offset to UTC and drops the milliseconds', () =>
    expect(formatFechaOdoo(new Date('2026-07-24T09:05:03.987+02:00'))).toBe('2026-07-24 07:05:03'))

  it('parseFechaOdoo reads Odoo datetimes as UTC', () =>
    expect(parseFechaOdoo('2026-09-29 11:12:15').toISOString()).toBe('2026-09-29T11:12:15.000Z'))

  it('parseFechaOdoo undoes formatFechaOdoo', () => {
    const fecha = new Date('2026-10-22T23:59:59Z')
    expect(parseFechaOdoo(formatFechaOdoo(fecha))).toEqual(fecha)
  })

  it('parseFechaOdoo rejects text that is not an Odoo datetime instead of returning an invalid date', () => {
    expect(() => parseFechaOdoo('ayer')).toThrow(/ayer/)
    expect(() => parseFechaOdoo('2026-09-29')).toThrow()
    expect(() => parseFechaOdoo('2026-13-45 99:99:99')).toThrow()
  })
})
