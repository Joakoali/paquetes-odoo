'use client'

import { useEffect, useRef, useState, type PointerEvent as EventoDePuntero } from 'react'

/** The width of the line, in CSS pixels. */
const GROSOR = 2.5

interface Punto {
  x: number
  y: number
}

/** Where the pointer is, in CSS pixels from the corner of the canvas (the context is scaled, so that is what it draws in). */
function puntoDe(canvas: HTMLCanvasElement, evento: { clientX: number; clientY: number }): Punto {
  const caja = canvas.getBoundingClientRect()
  return { x: evento.clientX - caja.left, y: evento.clientY - caja.top }
}

/**
 * Gives the canvas the size of its box, in device pixels so that the line is sharp on a high-density screen, and sets
 * the pen. Changing the size of a canvas erases it and resets its context, so this is the only place that does it.
 */
function ajustar(canvas: HTMLCanvasElement, ancho: number, alto: number): void {
  const densidad = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(ancho * densidad))
  canvas.height = Math.max(1, Math.round(alto * densidad))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(densidad, densidad)
  ctx.lineWidth = GROSOR
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // The ink is the color of the text of the app: the stylesheet says which it is.
  ctx.strokeStyle = getComputedStyle(canvas).color
}

/**
 * A box to sign in with a finger (or a pen, or a mouse). It takes the width of the container and is drawn at the density of
 * the screen. Every time a stroke ends it gives back the whole signature as a PNG data URL, and "Borrar" clears the box and
 * gives back null: whoever uses it always has what is on the screen.
 *
 * It does not keep its drawing when the box changes size (turning the phone): a canvas cannot be resized without erasing it,
 * and a signature stretched to another shape is not what was signed. The box is cleared then, and null is given back.
 *
 * `deshabilitado` is for while what was drawn is being sent: nothing can be drawn or cleared.
 */
export function SignaturePad({ onChange, alto, deshabilitado = false }: {
  onChange: (dataUrl: string | null) => void
  /** Height of the box in pixels. Without it, the one the stylesheet gives `.firma`. */
  alto?: number
  deshabilitado?: boolean
}) {
  const caja = useRef<HTMLDivElement>(null)
  const lienzo = useRef<HTMLCanvasElement>(null)
  // The stroke being drawn: the pointer that makes it, the last point and the middle of the last segment.
  const trazo = useRef<{ puntero: number; ultimo: Punto; medio: Punto } | null>(null)
  const hayTinta = useRef(false)
  const [conTinta, setConTinta] = useState(false)
  // The latest `onChange`, for the handlers that outlive a render (the observer of the size).
  const avisar = useRef(onChange)

  useEffect(() => {
    avisar.current = onChange
  })

  // The canvas is as big as its box, whatever the box does: the first time it is measured, and when the phone turns.
  useEffect(() => {
    const elemento = caja.current
    const canvas = lienzo.current
    if (!elemento || !canvas) return

    let ancho = 0
    let altura = 0
    const observador = new ResizeObserver(([medida]) => {
      const nuevoAncho = Math.floor(medida.contentRect.width)
      const nuevaAltura = Math.floor(medida.contentRect.height)
      if (nuevoAncho === ancho && nuevaAltura === altura) return
      ancho = nuevoAncho
      altura = nuevaAltura
      ajustar(canvas, ancho, altura)
      trazo.current = null
      if (hayTinta.current) {
        hayTinta.current = false
        setConTinta(false)
        avisar.current(null)
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
    // A tap is a dot: a line that goes nowhere, with round ends.
    ctx.beginPath()
    ctx.moveTo(punto.x, punto.y)
    ctx.lineTo(punto.x, punto.y)
    ctx.stroke()
    if (!hayTinta.current) {
      hayTinta.current = true
      setConTinta(true)
    }
  }

  function seguir(evento: EventoDePuntero<HTMLCanvasElement>) {
    const actual = trazo.current
    if (!actual || actual.puntero !== evento.pointerId) return
    const canvas = evento.currentTarget
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // A screen reports more points than events: the ones in between are what makes a fast stroke smooth and not angular.
    const intermedios = evento.nativeEvent.getCoalescedEvents?.() ?? []
    for (const movimiento of intermedios.length > 0 ? intermedios : [evento.nativeEvent]) {
      const punto = puntoDe(canvas, movimiento)
      const medio = { x: (actual.ultimo.x + punto.x) / 2, y: (actual.ultimo.y + punto.y) / 2 }
      // A curve from the middle of the last segment to the middle of this one, with the last point as its guide.
      ctx.beginPath()
      ctx.moveTo(actual.medio.x, actual.medio.y)
      ctx.quadraticCurveTo(actual.ultimo.x, actual.ultimo.y, medio.x, medio.y)
      ctx.stroke()
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
    if (ctx) {
      // The curves stop at the middle of the last segment: the line is finished up to the last point.
      ctx.beginPath()
      ctx.moveTo(actual.medio.x, actual.medio.y)
      ctx.lineTo(actual.ultimo.x, actual.ultimo.y)
      ctx.stroke()
    }
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
    hayTinta.current = false
    setConTinta(false)
    avisar.current(null)
  }

  return (
    <div ref={caja} className="firma" style={alto === undefined ? undefined : { height: alto }} aria-disabled={deshabilitado || undefined}>
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
