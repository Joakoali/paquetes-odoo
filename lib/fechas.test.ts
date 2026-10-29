import { describe, it, expect, afterEach } from 'vitest'
import { ZONA_HORARIA, fechaYHora, formatFechaOdoo, haceCuanto, inicioDeHoy, parseFechaOdoo } from './fechas'

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

describe('inicioDeHoy', () => {
  const TZ_ORIGINAL = process.env.TZ
  afterEach(() => {
    if (TZ_ORIGINAL === undefined) delete process.env.TZ
    else process.env.TZ = TZ_ORIGINAL
  })

  it('inicioDeHoy is midnight in Madrid, in summer and in winter', () => {
    expect(inicioDeHoy(new Date('2026-07-24T10:00:00Z')).toISOString()).toBe('2026-07-23T22:00:00.000Z')
    expect(inicioDeHoy(new Date('2026-12-02T10:00:00Z')).toISOString()).toBe('2026-12-01T23:00:00.000Z')
  })

  it('belongs to the Madrid day of the instant, not to its UTC day', () => {
    // 23:59:59 on the 23rd in Madrid is still the 23rd; one second later it is the 24th.
    expect(inicioDeHoy(new Date('2026-07-23T21:59:59Z')).toISOString()).toBe('2026-07-22T22:00:00.000Z')
    expect(inicioDeHoy(new Date('2026-07-23T22:00:00Z')).toISOString()).toBe('2026-07-23T22:00:00.000Z')
    // 00:30 in Madrid on the 24th is still the 23rd in UTC.
    expect(inicioDeHoy(new Date('2026-07-23T22:30:00Z')).toISOString()).toBe('2026-07-23T22:00:00.000Z')
  })

  it('drops the milliseconds of the instant it is given', () => {
    expect(inicioDeHoy(new Date('2026-12-02T10:11:12.987Z')).toISOString()).toBe('2026-12-01T23:00:00.000Z')
  })

  // The clocks change at night, so on the day of the change midnight and noon have different offsets:
  // a midnight computed with the offset of "now" is an hour off. The days after pin the new offset.
  it.each([
    ['the day the clocks go forward', '2026-03-29T12:00:00Z', '2026-03-28T23:00:00.000Z'],
    ['the day after the clocks went forward', '2026-03-30T12:00:00Z', '2026-03-29T22:00:00.000Z'],
    ['the day the clocks go back', '2026-10-25T12:00:00Z', '2026-10-24T22:00:00.000Z'],
    ['the day after the clocks went back', '2026-10-26T12:00:00Z', '2026-10-25T23:00:00.000Z'],
  ])('is right on %s', (_dia, ahora, esperado) => {
    expect(inicioDeHoy(new Date(ahora)).toISOString()).toBe(esperado)
  })

  it('does not depend on the time zone of the machine it runs on', () => {
    // The dev machine is in Spain and Vercel runs in UTC: the answer must be the same in both.
    process.env.TZ = 'America/Los_Angeles'
    expect(inicioDeHoy(new Date('2026-07-24T10:00:00Z')).toISOString()).toBe('2026-07-23T22:00:00.000Z')
    process.env.TZ = 'UTC'
    expect(inicioDeHoy(new Date('2026-12-02T10:00:00Z')).toISOString()).toBe('2026-12-01T23:00:00.000Z')
  })
})

describe('haceCuanto', () => {
  const AHORA = new Date('2026-10-22T12:00:00Z')
  const SEG = 1000
  const MIN = 60 * SEG
  const HORA = 60 * MIN
  const DIA = 24 * HORA

  it.each([
    ['no time at all', 'recién', 0],
    ['59 seconds', 'recién', 59 * SEG],
    ['one minute', 'hace 1 min', MIN],
    ['59 minutes and 59 seconds', 'hace 59 min', 59 * MIN + 59 * SEG],
    ['one hour', 'hace 1 h', HORA],
    ['23 hours and 59 minutes', 'hace 23 h', 23 * HORA + 59 * MIN],
    ['24 hours', 'ayer', DIA],
    ['47 hours and 59 minutes', 'ayer', 47 * HORA + 59 * MIN],
    ['48 hours', 'hace 2 días', 2 * DIA],
    ['ten days and five hours', 'hace 10 días', 10 * DIA + 5 * HORA],
  ])('%s ago reads "%s"', (_cuanto, esperado, milisegundos) => {
    expect(haceCuanto(new Date(AHORA.getTime() - milisegundos), AHORA)).toBe(esperado)
  })

  it('reads a moment slightly ahead of now as recién: the database clock and the app clock never agree exactly', () => {
    expect(haceCuanto(new Date(AHORA.getTime() + 5 * SEG), AHORA)).toBe('recién')
  })
})

describe('fechaYHora', () => {
  const AHORA = new Date('2026-10-29T12:00:00Z')

  it('says the day and the time on the clock of Madrid, in summer and in winter', () => {
    // 2 h ahead of UTC until the last Sunday of October, 1 h after it.
    expect(fechaYHora(new Date('2026-10-24T08:32:00Z'), AHORA)).toBe('24/10 10:32')
    expect(fechaYHora(new Date('2026-10-28T08:32:00Z'), AHORA)).toBe('28/10 09:32')
  })

  it('counts the day in Madrid: a quarter to midnight in UTC is already the next day there', () => {
    expect(fechaYHora(new Date('2026-10-28T23:45:00Z'), AHORA)).toBe('29/10 00:45')
  })

  it('says the year only when it is not the year of now', () => {
    expect(fechaYHora(new Date('2025-12-31T10:05:00Z'), AHORA)).toBe('31/12/2025 11:05')
  })
})
