import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** What a fake oscillator was asked to do. */
interface Tono {
  frecuencia: number
  forma: string
  inicio: number
  fin: number
  conectadoAGanancia: boolean
}

/** A stand-in for the AudioContext of the browser that writes down the sounds it is asked for. */
class AudioFalso {
  static instancias: AudioFalso[] = []
  static estadoInicial: 'running' | 'suspended' = 'suspended'
  static falloAlCrear = false
  static falloAlCrearOscilador = false

  state: string = AudioFalso.estadoInicial
  currentTime = 10
  destination = { destino: true }
  tonos: Tono[] = []
  resume = vi.fn(async () => {
    this.state = 'running'
  })

  constructor() {
    if (AudioFalso.falloAlCrear) throw new Error('The audio device is not available')
    AudioFalso.instancias.push(this)
  }

  createOscillator() {
    if (AudioFalso.falloAlCrearOscilador) throw new Error('boom')
    const tono: Tono = { frecuencia: 0, forma: '', inicio: 0, fin: 0, conectadoAGanancia: false }
    this.tonos.push(tono)
    return {
      set type(valor: string) { tono.forma = valor },
      frequency: { setValueAtTime: (frecuencia: number) => { tono.frecuencia = frecuencia } },
      connect: (otro: unknown) => { tono.conectadoAGanancia = otro !== this.destination },
      start: (cuando: number) => { tono.inicio = cuando },
      stop: (cuando: number) => { tono.fin = cuando },
    }
  }

  createGain() {
    return {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }
  }
}

beforeEach(() => {
  vi.resetModules()
  AudioFalso.instancias = []
  AudioFalso.estadoInicial = 'suspended'
  AudioFalso.falloAlCrear = false
  AudioFalso.falloAlCrearOscilador = false
  vi.stubGlobal('AudioContext', AudioFalso)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A fresh copy of the module, which has no context yet. */
const cargar = () => import('./sonidos')

describe('sonarOk and sonarAviso', () => {
  it('play a sound through the context of the browser', async () => {
    const { sonarOk } = await cargar()

    sonarOk()

    const [audio] = AudioFalso.instancias
    expect(audio.tonos.length).toBeGreaterThan(0)
    for (const tono of audio.tonos) {
      expect(tono.frecuencia).toBeGreaterThan(0)
      expect(tono.fin).toBeGreaterThan(tono.inicio)
      expect(tono.inicio).toBeGreaterThanOrEqual(audio.currentTime)
      expect(tono.conectadoAGanancia).toBe(true)
    }
  })

  it('sound different: the warning is lower, and lasts longer, than the one for a package that went in', async () => {
    const { sonarAviso, sonarOk } = await cargar()

    sonarOk()
    const [audio] = AudioFalso.instancias
    const ok = audio.tonos.splice(0)
    sonarAviso()
    const aviso = audio.tonos.splice(0)

    expect(ok.length).toBeGreaterThan(0)
    expect(aviso.length).toBeGreaterThan(0)
    expect(Math.max(...aviso.map((tono) => tono.frecuencia))).toBeLessThan(Math.min(...ok.map((tono) => tono.frecuencia)))
    const duracion = (tonos: Tono[]) => Math.max(...tonos.map((tono) => tono.fin)) - Math.min(...tonos.map((tono) => tono.inicio))
    expect(duracion(aviso)).toBeGreaterThan(duracion(ok))
  })

  it('make the context once and use it for every sound', async () => {
    const { sonarAviso, sonarOk } = await cargar()

    sonarOk()
    sonarOk()
    sonarAviso()

    expect(AudioFalso.instancias).toHaveLength(1)
  })

  it('wake a context that the browser has left suspended, and let a running one be', async () => {
    const { sonarOk } = await cargar()
    sonarOk()
    expect(AudioFalso.instancias[0].resume).toHaveBeenCalledTimes(1)

    sonarOk() // it is running now
    expect(AudioFalso.instancias[0].resume).toHaveBeenCalledTimes(1)
  })

  it('do not wake a context that is already running', async () => {
    AudioFalso.estadoInicial = 'running'
    const { sonarOk } = await cargar()

    sonarOk()

    expect(AudioFalso.instancias[0].resume).not.toHaveBeenCalled()
  })

  it('use the prefixed context of the old Safari when there is no other', async () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', AudioFalso)
    const { sonarOk } = await cargar()

    sonarOk()

    expect(AudioFalso.instancias).toHaveLength(1)
    expect(AudioFalso.instancias[0].tonos.length).toBeGreaterThan(0)
  })

  it('are silent, and do not throw, where there is no AudioContext at all', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const { sonarAviso, sonarOk } = await cargar()

    expect(() => sonarOk()).not.toThrow()
    expect(() => sonarAviso()).not.toThrow()
    expect(AudioFalso.instancias).toHaveLength(0)
  })

  it('are silent, and do not throw, when the browser will not make a context', async () => {
    AudioFalso.falloAlCrear = true
    const { sonarAviso, sonarOk } = await cargar()

    expect(() => sonarOk()).not.toThrow()
    expect(() => sonarAviso()).not.toThrow()
  })

  it('are silent, and do not throw, when the sound fails halfway', async () => {
    AudioFalso.falloAlCrearOscilador = true
    const { sonarAviso, sonarOk } = await cargar()

    expect(() => sonarOk()).not.toThrow()
    expect(() => sonarAviso()).not.toThrow()
  })

  it('are silent, and do not throw, when waking the context is refused', async () => {
    const { sonarOk } = await cargar()
    sonarOk()
    const [audio] = AudioFalso.instancias
    audio.state = 'suspended'
    audio.resume.mockRejectedValue(new Error('NotAllowedError'))

    expect(() => sonarOk()).not.toThrow()
    await Promise.resolve() // a refusal that comes late must not end as an unhandled rejection either
  })
})

describe('prepararSonidos', () => {
  /** A document that remembers its listeners, and can fire them. */
  function documentoFalso() {
    const oyentes = new Map<string, () => void>()
    const documento = {
      addEventListener: vi.fn((tipo: string, oyente: () => void) => { oyentes.set(tipo, oyente) }),
      removeEventListener: vi.fn((tipo: string) => { oyentes.delete(tipo) }),
    }
    vi.stubGlobal('document', documento)
    return { documento, oyentes }
  }

  it('makes and wakes the context at the first touch, which is when the browser lets it', async () => {
    const { oyentes } = documentoFalso()
    const { prepararSonidos } = await cargar()

    prepararSonidos()
    expect(AudioFalso.instancias).toHaveLength(0) // nothing before somebody touches the screen

    oyentes.get('pointerdown')?.()

    expect(AudioFalso.instancias).toHaveLength(1)
    expect(AudioFalso.instancias[0].resume).toHaveBeenCalledTimes(1)
  })

  it('also does it at the first key, which is what the gun is for a tablet nobody touches', async () => {
    const { oyentes } = documentoFalso()
    const { prepararSonidos } = await cargar()

    prepararSonidos()
    oyentes.get('keydown')?.()

    expect(AudioFalso.instancias).toHaveLength(1)
  })

  it('stops listening after the first one of them, and its cleanup leaves nothing behind', async () => {
    const { documento, oyentes } = documentoFalso()
    const { prepararSonidos } = await cargar()

    const limpiar = prepararSonidos()
    oyentes.get('pointerdown')?.()

    expect(oyentes.size).toBe(0)
    limpiar()
    expect(documento.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    expect(documento.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function))
  })

  it('can be cleaned up before anybody touched anything', async () => {
    const { oyentes } = documentoFalso()
    const { prepararSonidos } = await cargar()

    prepararSonidos()()

    expect(oyentes.size).toBe(0)
    expect(AudioFalso.instancias).toHaveLength(0)
  })

  it('does nothing, and does not throw, where there is no document', async () => {
    vi.stubGlobal('document', undefined)
    const { prepararSonidos } = await cargar()

    expect(() => prepararSonidos()()).not.toThrow()
  })

  it('stays silent when the context cannot be made at the touch', async () => {
    AudioFalso.falloAlCrear = true
    const { oyentes } = documentoFalso()
    const { prepararSonidos } = await cargar()

    prepararSonidos()

    expect(() => oyentes.get('pointerdown')?.()).not.toThrow()
  })
})
