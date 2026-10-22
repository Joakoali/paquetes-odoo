/** The time zone the warehouses work in: "today" and "this morning" are counted in it. */
export const ZONA_HORARIA = 'Europe/Madrid'

const FECHA_ODOO = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/

/** `YYYY-MM-DD HH:MM:SS` in UTC: how Odoo writes datetimes and how its domains want them. */
export function formatFechaOdoo(fecha: Date): string {
  return fecha.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Odoo sends datetimes as `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker, so the
 * text is read as UTC and not in the machine's zone. Anything else throws: a silent
 * `Invalid Date` would only fail later, far from the cause.
 */
export function parseFechaOdoo(texto: string): Date {
  const partes = FECHA_ODOO.exec(texto)
  const fecha = partes ? new Date(`${partes[1]}T${partes[2]}Z`) : null
  if (!fecha || Number.isNaN(fecha.getTime())) throw new Error(`Not an Odoo datetime: "${texto}"`)
  return fecha
}
