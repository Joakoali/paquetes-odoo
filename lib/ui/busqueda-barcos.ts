/** How long the field waits after the last key before it asks the server (ms). */
export const ESPERA_MS = 200

/** A search with fewer letters than this is not made: one letter matches half the barcos. */
export const LETRAS_MINIMAS = 2

/**
 * What to ask the server for, given what is in the field: the text without the blanks at its ends, or null when it
 * is too short to search. What is inside is kept as it was typed (a name can have spaces).
 */
export function textoABuscar(escrito: string): string | null {
  const texto = escrito.trim()
  return texto.length >= LETRAS_MINIMAS ? texto : null
}

/**
 * The count of requests of one search field. The answers of the server do not come back in the order the
 * requests went (the one for "h" can take longer than the one for "h3"), and the screen must show the answer to
 * the last thing typed, not the last answer to arrive: each request takes a number, and an answer is only used if
 * its number is still the latest.
 */
export function contadorDePedidos() {
  let ultimo = 0
  return {
    /** Starts a request, and makes every one before it stale. */
    nuevo: (): number => ++ultimo,
    /** Whether `pedido` is still the latest: only then is its answer the one to show. */
    esVigente: (pedido: number): boolean => pedido === ultimo,
  }
}
