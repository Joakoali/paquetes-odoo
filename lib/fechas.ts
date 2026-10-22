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

// Built once: creating an Intl.DateTimeFormat costs far more than using it. `h23` so that
// midnight reads 00 and not 24. Never `Date`'s local getters: the machine is not in ZONA_HORARIA.
const RELOJ_DE_LA_ZONA = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONA_HORARIA,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** What the wall clock of ZONA_HORARIA shows at `instante` (month from 1 to 12). */
function relojDeLaZona(instante: Date) {
  const partes = RELOJ_DE_LA_ZONA.formatToParts(instante)
  const valor = (tipo: Intl.DateTimeFormatPartTypes) => Number(partes.find((parte) => parte.type === tipo)?.value)
  return {
    anio: valor('year'),
    mes: valor('month'),
    dia: valor('day'),
    hora: valor('hour'),
    minuto: valor('minute'),
    segundo: valor('second'),
  }
}

/** How many ms the clock of ZONA_HORARIA is ahead of UTC at `instante`: 1 h in winter, 2 h in summer. */
function desfaseDeLaZona(instante: Date): number {
  const { anio, mes, dia, hora, minuto, segundo } = relojDeLaZona(instante)
  // The formatter drops the milliseconds, so the instant is cut to the second to compare like with like.
  return Date.UTC(anio, mes - 1, dia, hora, minuto, segundo) - Math.floor(instante.getTime() / 1000) * 1000
}

/** 00:00 of the day `ahora` falls on in ZONA_HORARIA, as an instant: what "today" starts counting from. */
export function inicioDeHoy(ahora: Date): Date {
  const { anio, mes, dia } = relojDeLaZona(ahora)
  // That midnight as it would be if the zone were UTC. Its real instant is the offset earlier, and the
  // offset of `ahora` is not the right one: the clocks change at night, so a day's midnight and its noon
  // can have different offsets. It is measured at the midnight itself, in two passes because the first
  // guess is an hour off, and could fall on the other side of a change.
  const medianoche = Date.UTC(anio, mes - 1, dia)
  const primeraEstimacion = medianoche - desfaseDeLaZona(new Date(medianoche))
  return new Date(medianoche - desfaseDeLaZona(new Date(primeraEstimacion)))
}

/**
 * How long ago `desde` was, in the words the screens use: "recién", "hace 5 min", "hace 3 h",
 * "ayer" (24 to 48 hours) or "hace 3 días". Elapsed time, not calendar days: 26 hours ago is
 * "ayer" even if the clock says the same date.
 */
export function haceCuanto(desde: Date, ahora: Date): string {
  // A `desde` ahead of `ahora` (the database clock and the app clock never agree to the millisecond) is now.
  const minutos = Math.floor(Math.max(0, ahora.getTime() - desde.getTime()) / 60_000)
  if (minutos < 1) return 'recién'
  if (minutos < 60) return `hace ${minutos} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `hace ${horas} h`
  const dias = Math.floor(horas / 24)
  return dias === 1 ? 'ayer' : `hace ${dias} días`
}
