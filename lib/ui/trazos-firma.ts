/** A point of a stroke, in CSS pixels from the corner of the box it was drawn in. */
export interface Punto {
  x: number
  y: number
}

/** What a finger drew from the moment it touched the box to the moment it left it. A single point is a tap. */
export type Trazo = Punto[]

/** The size of the box to sign in, in CSS pixels. */
export interface Medida {
  ancho: number
  alto: number
}

/**
 * Where the strokes of a signature are when the box changes size (the phone turns, the on-screen keyboard opens, the
 * screen is taller or shorter than it was). The signature is kept as strokes, not as a picture, so it can be drawn again
 * in the new box instead of being lost (a canvas that changes size is erased).
 *
 * What is drawn does not move unless it has to: if it still fits in the box it stays exactly where it is, at the size it
 * was drawn. If it does not fit (the box got narrower or shorter) it is scaled down, by the same amount on both axes so
 * it is not squeezed, as little as it takes to fit, from the corner. It is never made bigger.
 *
 * A box with no size (it is not laid out yet) says nothing about where the strokes go, so they are left alone. It never
 * changes what it is given.
 */
export function ajustarTrazos(trazos: Trazo[], caja: Medida): Trazo[] {
  if (caja.ancho <= 0 || caja.alto <= 0) return trazos

  let masAncho = 0
  let masAlto = 0
  for (const trazo of trazos) {
    for (const { x, y } of trazo) {
      masAncho = Math.max(masAncho, x)
      masAlto = Math.max(masAlto, y)
    }
  }

  // A signature that ends at 0 has nothing to scale by: dividing by it gives Infinity, which never is the smallest.
  const escala = Math.min(1, caja.ancho / masAncho, caja.alto / masAlto)
  if (escala === 1) return trazos
  return trazos.map((trazo) => trazo.map(({ x, y }) => ({ x: x * escala, y: y * escala })))
}
