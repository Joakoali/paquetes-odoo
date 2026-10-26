import { describe, expect, it } from 'vitest'
import { ajustarTrazos, type Trazo } from './trazos-firma'

/** Two strokes: a line, and a tap at its far corner. */
const trazos: Trazo[] = [
  [{ x: 10, y: 20 }, { x: 60, y: 80 }, { x: 110, y: 40 }],
  [{ x: 200, y: 100 }],
]

describe('ajustarTrazos', () => {
  it('leaves the signature where it is when the box is the same size', () => {
    expect(ajustarTrazos(trazos, { ancho: 300, alto: 200 })).toEqual(trazos)
  })

  it('leaves it where it is, not centered nor stretched, in a box that is bigger (the phone turned to landscape)', () => {
    expect(ajustarTrazos(trazos, { ancho: 700, alto: 400 })).toEqual(trazos)
  })

  it('leaves it where it is when it still fits, even in a box that is smaller than the one it was drawn in', () => {
    expect(ajustarTrazos(trazos, { ancho: 210, alto: 110 })).toEqual(trazos)
  })

  it('leaves it alone when it just touches the edge of the box', () => {
    expect(ajustarTrazos(trazos, { ancho: 200, alto: 100 })).toEqual(trazos)
  })

  it('shrinks it, on both axes by the same amount, when it is too wide for the box', () => {
    // The tap is at x=200: a box 100 wide takes half of it.
    expect(ajustarTrazos(trazos, { ancho: 100, alto: 200 })).toEqual([
      [{ x: 5, y: 10 }, { x: 30, y: 40 }, { x: 55, y: 20 }],
      [{ x: 100, y: 50 }],
    ])
  })

  it('shrinks it, on both axes by the same amount, when it is too tall for the box (the on-screen keyboard is open)', () => {
    // The tap is at y=100: a box 50 tall takes half of it.
    expect(ajustarTrazos(trazos, { ancho: 300, alto: 50 })).toEqual([
      [{ x: 5, y: 10 }, { x: 30, y: 40 }, { x: 55, y: 20 }],
      [{ x: 100, y: 50 }],
    ])
  })

  it('takes the axis that asks for the most when both are too small', () => {
    expect(ajustarTrazos(trazos, { ancho: 100, alto: 25 })).toEqual([
      [{ x: 2.5, y: 5 }, { x: 15, y: 20 }, { x: 27.5, y: 10 }],
      [{ x: 50, y: 25 }],
    ])
  })

  it('keeps all of it inside the box, whatever the box', () => {
    for (const caja of [{ ancho: 120, alto: 90 }, { ancho: 50, alto: 300 }, { ancho: 333, alto: 17 }]) {
      for (const trazo of ajustarTrazos(trazos, caja)) {
        for (const { x, y } of trazo) {
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(caja.ancho)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(y).toBeLessThanOrEqual(caja.alto)
        }
      }
    }
  })

  it('does not change what it was given', () => {
    const antes = structuredClone(trazos)

    ajustarTrazos(trazos, { ancho: 100, alto: 25 })

    expect(trazos).toEqual(antes)
  })

  it('is nothing for no strokes', () => {
    expect(ajustarTrazos([], { ancho: 100, alto: 100 })).toEqual([])
  })

  it('leaves the strokes alone when the box has no size: a box that is not laid out says nothing about where they go', () => {
    expect(ajustarTrazos(trazos, { ancho: 0, alto: 0 })).toEqual(trazos)
    expect(ajustarTrazos(trazos, { ancho: 0, alto: 200 })).toEqual(trazos)
    expect(ajustarTrazos(trazos, { ancho: 300, alto: 0 })).toEqual(trazos)
  })

  it('is not troubled by a tap in the corner: there is nothing to scale it by', () => {
    expect(ajustarTrazos([[{ x: 0, y: 0 }]], { ancho: 10, alto: 10 })).toEqual([[{ x: 0, y: 0 }]])
  })
})
