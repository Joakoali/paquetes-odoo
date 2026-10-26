'use client'

import { useEffect, useRef, useState, type PointerEvent as EventoDePuntero } from 'react'
import { ajustarTrazos, type Medida, type Punto, type Trazo } from '@/lib/ui/trazos-firma'

/** The width of the line, in CSS pixels. */
const GROSOR = 2.5

/** Where the pointer is, in CSS pixels from the corner of the canvas (the context is scaled, so that is what it draws in). */
function puntoDe(canvas: HTMLCanvasElement, evento: { clientX: number; clientY: number }): Punto {
  const caja = canvas.getBoundingClientRect()
  // A finger that leaves the box while it draws (the pointer is captured) goes on at its edge, so that nothing is outside.
  return {
    x: Math.min(Math.max(evento.clientX - caja.left, 0), caja.width),
    y: Math.min(Math.max(evento.clientY - caja.top, 0), caja.height),
  }
}

function puntoMedio(a: Punto, b: Punto): Punto {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * How a stroke is drawn, a piece at a time, so that it is the same when it is drawn as the finger moves and when it is
 * drawn again from its points: a tap is a dot (a line that goes nowhere, with round ends); each new point continues the
 * line with a curve from the middle of the last segment to the middle of this one, with the last point as its guide (so
 * a fast stroke is smooth and not angular); and the end is a straight line from the last middle to the last point.
 */
function dibujarPunto(ctx: CanvasRenderingContext2D, punto: Punto): void {
  ctx.beginPath()
  ctx.moveTo(punto.x, punto.y)
  ctx.lineTo(punto.x, punto.y)
  ctx.stroke()
}

function dibujarCurva(ctx: CanvasRenderingContext2D, desde: Punto, guia: Punto, hasta: Punto): void {
  ctx.beginPath()
  ctx.moveTo(desde.x, desde.y)
  ctx.quadraticCurveTo(guia.x, guia.y, hasta.x, hasta.y)
  ctx.stroke()
}

function dibujarFinal(ctx: CanvasRenderingContext2D, desde: Punto, hasta: Punto): void {
  ctx.beginPath()
  ctx.moveTo(desde.x, desde.y)
  ctx.lineTo(hasta.x, hasta.y)
  ctx.stroke()
}

/** Where a stroke stands after its points: the last one, and the middle of the last segment (the point itself for a tap). */
function estadoDeTrazo(puntos: Trazo): { ultimo: Punto; medio: Punto } {
  const ultimo = puntos[puntos.length - 1]
  return { ultimo, medio: puntos.length > 1 ? puntoMedio(puntos[puntos.length - 2], ultimo) : ultimo }
}

/** A stroke drawn again from its points. */
function dibujarTrazo(ctx: CanvasRenderingContext2D, puntos: Trazo): void {
  dibujarPunto(ctx, puntos[0])
  let ultimo = puntos[0]
  let medio = puntos[0]
  for (const punto of puntos.slice(1)) {
    const siguienteMedio = puntoMedio(ultimo, punto)
    dibujarCurva(ctx, medio, ultimo, siguienteMedio)
    ultimo = punto
    medio = siguienteMedio
  }
  dibujarFinal(ctx, medio, ultimo)
}

/**
 * Gives the canvas the size of its box, in device pixels so that the line is sharp on a high-density screen, and sets
 * the pen. Changing the size of a canvas erases it and resets its context, so what was drawn has to be drawn again.
 */
function ajustar(canvas: HTMLCanvasElement, medida: Medida): CanvasRenderingContext2D | null {
  const densidad = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(medida.ancho * densidad))
  canvas.height = Math.max(1, Math.round(medida.alto * densidad))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(densidad, densidad)
  ctx.lineWidth = GROSOR
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // The ink is the color of the text of the app: the stylesheet says which it is.
  ctx.strokeStyle = getComputedStyle(canvas).color
  return ctx
}

/**
 * A box to sign in with a finger (or a pen, or a mouse). It takes the width of the container and its height too (the
 * stylesheet makes it as tall as the screen allows), and it is drawn at the density of the screen. Every time a stroke
 * ends it gives back the whole signature as a PNG data URL, and "Borrar" clears the box and gives back null: whoever uses
 * it always has what is on the screen.
 *
 * The box changes size when the phone turns or the on-screen keyboard opens, and a canvas cannot change size without being
 * erased. So the signature is also kept as strokes (`trazos-firma.ts`), and the canvas is drawn again from them in the new
 * size: it is still there, it is not given back again (it is the same signature), and it can be locked meanwhile.
 *
 * `deshabilitado` is for while what was drawn is being sent, and after that failed: nothing can be drawn or cleared.
 */
export function SignaturePad({ onChange, alto, deshabilitado = false }: {
  onChange: (dataUrl: string | null) => void
  /** Height of the box in pixels. Without it, the box takes the room the stylesheet gives `.firma`. */
  alto?: number
  deshabilitado?: boolean
}) {
  const caja = useRef<HTMLDivElement>(null)
  const lienzo = useRef<HTMLCanvasElement>(null)
  // What is signed: every stroke, in the coordinates of the box as it is now. While a stroke is on, it is the last one.
  const trazos = useRef<Trazo[]>([])
  const medida = useRef<Medida>({ ancho: 0, alto: 0 })
  // The stroke being drawn: the pointer that makes it, the last point and the middle of the last segment.
  const trazo = useRef<{ puntero: number; ultimo: Punto; medio: Punto } | null>(null)
  const [conTinta, setConTinta] = useState(false)
  // The latest `onChange`, for the handlers that outlive a render (the observer of the size).
  const avisar = useRef(onChange)

  useEffect(() => {
    avisar.current = onChange
  })

  // The canvas is as big as its box, whatever the box does: the first time it is measured, and every time it changes.
  useEffect(() => {
    const elemento = caja.current
    const canvas = lienzo.current
    if (!elemento || !canvas) return

    const observador = new ResizeObserver(([medido]) => {
      const nueva = { ancho: Math.floor(medido.contentRect.width), alto: Math.floor(medido.contentRect.height) }
      // A box that is not laid out (hidden) has nothing to draw in: the strokes wait for it to have a size.
      if (nueva.ancho === 0 || nueva.alto === 0) return
      if (nueva.ancho === medida.current.ancho && nueva.alto === medida.current.alto) return

      medida.current = nueva
      trazos.current = ajustarTrazos(trazos.current, nueva)
      const ctx = ajustar(canvas, nueva)
      if (ctx) {
        for (const puntos of trazos.current) dibujarTrazo(ctx, puntos)
      }

      // A stroke that was being drawn goes on from where it is now.
      const actual = trazo.current
      if (actual && trazos.current.length > 0) {
        trazo.current = { puntero: actual.puntero, ...estadoDeTrazo(trazos.current[trazos.current.length - 1]) }
      }
    })
    observador.observe(elemento)
    return () => observador.disconnect()
  }, [])

  function empezar(evento: EventoDePuntero<HTMLCanvasElement>) {
    if (deshabilitado || trazo.current) return
    if (evento.pointerType === 'mouse' && evento.button !== 0) return
    const canvas = evento.currentTarget
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // The pointer is followed also when it leaves the box, so that a stroke that goes out is not cut.
    canvas.setPointerCapture(evento.pointerId)
    const punto = puntoDe(canvas, evento)
    trazo.current = { puntero: evento.pointerId, ultimo: punto, medio: punto }
    trazos.current = [...trazos.current, [punto]]
    dibujarPunto(ctx, punto)
    if (trazos.current.length === 1) setConTinta(true)
  }

  function seguir(evento: EventoDePuntero<HTMLCanvasElement>) {
    const actual = trazo.current
    if (!actual || actual.puntero !== evento.pointerId) return
    const canvas = evento.currentTarget
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const puntos = trazos.current[trazos.current.length - 1]
    // A screen reports more points than events: the ones in between are what makes a fast stroke smooth and not angular.
    const intermedios = evento.nativeEvent.getCoalescedEvents?.() ?? []
    for (const movimiento of intermedios.length > 0 ? intermedios : [evento.nativeEvent]) {
      const punto = puntoDe(canvas, movimiento)
      puntos.push(punto)
      const medio = puntoMedio(actual.ultimo, punto)
      dibujarCurva(ctx, actual.medio, actual.ultimo, medio)
      actual.ultimo = punto
      actual.medio = medio
    }
  }

  function terminar(evento: EventoDePuntero<HTMLCanvasElement>) {
    const actual = trazo.current
    if (!actual || actual.puntero !== evento.pointerId) return
    trazo.current = null
    const canvas = evento.currentTarget
    const ctx = canvas.getContext('2d')
    // The curves stop at the middle of the last segment: the line is finished up to the last point.
    if (ctx) dibujarFinal(ctx, actual.medio, actual.ultimo)
    avisar.current(canvas.toDataURL('image/png'))
  }

  function borrar() {
    const canvas = lienzo.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
    trazo.current = null
    trazos.current = []
    setConTinta(false)
    avisar.current(null)
  }

  return (
    <div
      ref={caja}
      className="firma"
      // With a height of its own the box does not take part in the space the stylesheet shares out.
      style={alto === undefined ? undefined : { flex: 'none', height: alto, minHeight: 0 }}
      aria-disabled={deshabilitado || undefined}
    >
      <canvas
        ref={lienzo}
        className="firma-lienzo"
        aria-label="Recuadro para firmar con el dedo"
        onPointerDown={empezar}
        onPointerMove={seguir}
        onPointerUp={terminar}
        onPointerCancel={terminar}
      />
      <span className="firma-linea" aria-hidden="true" />
      {conTinta ? null : <span className="firma-pista" aria-hidden="true">Firmar con el dedo</span>}
      <button type="button" className="btn-link firma-borrar" disabled={deshabilitado || !conTinta} onClick={borrar}>
        Borrar
      </button>
    </div>
  )
}
