/*
 * The one rule by which a tracking number is looked for, wherever it is: the filter of each list of packages, and the
 * search of where a package is, in the database and in Odoo. A part of the number is enough (the last digits, say), and
 * neither the case nor the blanks count.
 */

/** A search across the barcos and Odoo takes at least this many characters: fewer would match half the packages there are. */
export const MIN_CARACTERES_BUSQUEDA = 4

/** What is kept of what was typed or scanned: no tracking number is longer, and it caps what reaches a query. */
export const MAX_CARACTERES_BUSQUEDA = 64

/** A list shorter than this is read at a glance, and has no filter unless it is opened with one. */
export const MIN_PARA_FILTRAR = 6

/** A tracking number as it is compared: without blanks anywhere and in lower case. Nothing else changes ("/" and "-" stay). */
export function normalizarTracking(texto: string): string {
  return texto.replace(/\s+/g, '').toLowerCase()
}

/**
 * Whether a tracking number contains what was typed, both as `normalizarTracking` leaves them. Nothing typed matches every
 * package; a package without number (a line of Odoo with no lot) matches nothing that was typed.
 */
export function coincideTracking(trackingNumber: string | null, buscado: string): boolean {
  const parte = normalizarTracking(buscado)
  if (parte === '') return true
  return trackingNumber !== null && normalizarTracking(trackingNumber).includes(parte)
}

/** Whether any of these tracking numbers contains what was typed: what a row with more than one package (a problem) is found by. */
export function coincideAlguno(trackingNumbers: ReadonlyArray<string | null>, buscado: string): boolean {
  return normalizarTracking(buscado) === '' || trackingNumbers.some((trackingNumber) => coincideTracking(trackingNumber, buscado))
}

/** The items whose tracking number contains what was typed, in their order. */
export function filtrarPorTracking<T extends { trackingNumber: string | null }>(items: readonly T[], buscado: string): T[] {
  return items.filter((item) => coincideTracking(item.trackingNumber, buscado))
}

/** Whether a list shows its filter: from MIN_PARA_FILTRAR rows, or whatever its length when it was opened with one (from the search). */
export function mostrarFiltro(total: number, filtroInicial: string): boolean {
  return total >= MIN_PARA_FILTRAR || filtroInicial !== ''
}

/** What the filter says under it: how many rows of the list it leaves, or that none has what was typed. Null with nothing typed. */
export function textoDelFiltro({ visibles, total, buscado }: { visibles: number; total: number; buscado: string }): string | null {
  if (normalizarTracking(buscado) === '') return null
  if (visibles === 0) return `Ningún paquete tiene «${buscado.trim()}» en el tracking.`
  return `Mostrando ${visibles} de ${total}`
}

/**
 * The `q` of an address, as a screen takes it: its first value when it comes more than once, without the blanks at its ends
 * and cut to MAX_CARACTERES_BUSQUEDA. Empty when there is none. It is what was typed, to be shown back: comparing
 * normalizes it.
 */
export function valorDeLaDireccion(valor: string | string[] | undefined): string {
  const primero = Array.isArray(valor) ? valor[0] : valor
  return (primero ?? '').trim().slice(0, MAX_CARACTERES_BUSQUEDA)
}

/** What to look for across the barcos and Odoo, given what is in the field: normalized, or null when it is too short to search. */
export function textoDeBusqueda(escrito: string): string | null {
  const texto = normalizarTracking(escrito)
  return texto.length >= MIN_CARACTERES_BUSQUEDA ? texto : null
}
