/*
 * The two sounds of the reception screen, so that the operario does not have to look at it after every scan: a short
 * high one when the package went in, and a lower, longer one for anything he has to look at (a duplicate, a code that
 * is already somewhere, a scan that failed). They are made with Web Audio, with no files to load, and they are a
 * help and nothing more: if the browser has no audio, will not make a context or fails halfway, there is silence.
 */

type ConstructorDeAudio = new () => AudioContext

/** One context for the whole page: browsers limit how many may be open. Made at the first touch (see `prepararSonidos`). */
let contexto: AudioContext | null = null

function constructorDeAudio(): ConstructorDeAudio | null {
  // The Safari before 14.1 only has the prefixed one.
  const global = globalThis as typeof globalThis & { webkitAudioContext?: ConstructorDeAudio }
  return global.AudioContext ?? global.webkitAudioContext ?? null
}

function obtenerContexto(): AudioContext | null {
  if (contexto) return contexto
  const Constructor = constructorDeAudio()
  if (!Constructor) return null
  try {
    contexto = new Constructor()
  } catch {
    return null
  }
  return contexto
}

/** A context made without a touch, or one the system stopped (a call, the tablet asleep), starts suspended. */
function despertar(audio: AudioContext): void {
  if (audio.state === 'running') return
  try {
    // Promise.resolve: very old versions answer nothing. The browser may refuse it, and that is only silence.
    Promise.resolve(audio.resume()).catch(() => {})
  } catch {
    // Nothing to do: the sound that follows will not be heard.
  }
}

interface Tono {
  frecuencia: number
  /** Seconds after now. */
  inicio: number
  duracion: number
  forma: OscillatorType
  volumen: number
}

function tocar(tonos: Tono[]): void {
  try {
    const audio = obtenerContexto()
    if (!audio) return
    despertar(audio)

    for (const { frecuencia, inicio, duracion, forma, volumen } of tonos) {
      const oscilador = audio.createOscillator()
      const ganancia = audio.createGain()
      const desde = audio.currentTime + inicio
      oscilador.type = forma
      oscilador.frequency.setValueAtTime(frecuencia, desde)
      // A quick rise and fall: a sound that starts and ends at full volume clicks.
      ganancia.gain.setValueAtTime(0.0001, desde)
      ganancia.gain.exponentialRampToValueAtTime(volumen, desde + 0.01)
      ganancia.gain.exponentialRampToValueAtTime(0.0001, desde + duracion)
      oscilador.connect(ganancia)
      ganancia.connect(audio.destination)
      oscilador.start(desde)
      oscilador.stop(desde + duracion + 0.05)
    }
  } catch {
    // Silence: the screen says the same in writing.
  }
}

/** The package went in: two short high notes, going up. */
export function sonarOk(): void {
  tocar([
    { frecuencia: 880, inicio: 0, duracion: 0.09, forma: 'sine', volumen: 0.3 },
    { frecuencia: 1320, inicio: 0.09, duracion: 0.12, forma: 'sine', volumen: 0.3 },
  ])
}

/** Something to look at: two low, rough pulses, longer than the other one and nothing like it. */
export function sonarAviso(): void {
  tocar([
    { frecuencia: 196, inicio: 0, duracion: 0.2, forma: 'square', volumen: 0.12 },
    { frecuencia: 196, inicio: 0.26, duracion: 0.28, forma: 'square', volumen: 0.12 },
  ])
}

/**
 * Lets the sounds be heard. Browsers only start audio for a page the operario has touched, and a scan is answered
 * well after the gesture that sent it, so the context has to be made and woken at the first touch or key (the
 * gun is a keyboard: a tablet that is only ever scanned into is never touched). Call it once the screen is
 * drawn; it gives back what undoes it.
 */
export function prepararSonidos(): () => void {
  if (typeof document === 'undefined') return () => {}

  const eventos = ['pointerdown', 'keydown'] as const
  const dejarDeEscuchar = () => {
    for (const evento of eventos) document.removeEventListener(evento, alPrimerToque)
  }
  function alPrimerToque() {
    dejarDeEscuchar()
    const audio = obtenerContexto()
    if (audio) despertar(audio)
  }

  for (const evento of eventos) document.addEventListener(evento, alPrimerToque, { passive: true })
  return dejarDeEscuchar
}
