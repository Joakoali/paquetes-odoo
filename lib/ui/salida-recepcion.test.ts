import { describe, expect, it } from 'vitest'
import {
  agregarNoGuardados, decidirEscaneo, empezarASalir, RECEPCION_ABIERTA, terminarDeSalir, textoDeNoGuardados, textoDeRechazo,
  type EstadoDeSalida,
} from './salida-recepcion'

const cerrando: EstadoDeSalida = { fase: 'cerrando', rechazados: [] }

describe('decidirEscaneo', () => {
  it('sends the code to the server while nothing is leaving the screen: the usual path, nothing changes', () => {
    expect(decidirEscaneo(RECEPCION_ABIERTA, '1Z999')).toEqual({ estado: RECEPCION_ABIERTA, despachar: true })
  })

  it('does not send a code that the gun fires once a leaving action has started: it would queue behind it and fail', () => {
    const { estado, despachar } = decidirEscaneo(cerrando, '1Z999')

    expect(despachar).toBe(false)
    expect(estado).toEqual({ fase: 'cerrando', rechazados: ['1Z999'] })
  })

  it('keeps the refused codes in the order the gun fired them', () => {
    let estado = cerrando
    for (const codigo of ['A', 'B', 'C']) estado = decidirEscaneo(estado, codigo).estado

    expect(estado.rechazados).toEqual(['A', 'B', 'C'])
  })

  it('names a code that is fired twice once', () => {
    let estado = cerrando
    for (const codigo of ['A', 'B', 'A']) estado = decidirEscaneo(estado, codigo).estado

    expect(estado.rechazados).toEqual(['A', 'B'])
  })

  it('refuses codes also once the leaving action worked and the screen is held for the operario to read', () => {
    const { estado, despachar } = decidirEscaneo({ fase: 'cerrada', rechazados: ['A'] }, 'B')

    expect(despachar).toBe(false)
    expect(estado).toEqual({ fase: 'cerrada', rechazados: ['A', 'B'] })
  })

  it('does not change the state it was given', () => {
    const antes: EstadoDeSalida = { fase: 'cerrando', rechazados: ['A'] }

    decidirEscaneo(antes, 'B')

    expect(antes).toEqual({ fase: 'cerrando', rechazados: ['A'] })
  })
})

describe('empezarASalir', () => {
  it('closes the screen to scans', () => {
    expect(empezarASalir(RECEPCION_ABIERTA)).toEqual({ fase: 'cerrando', rechazados: [] })
  })

  it('does nothing to one that is already closing or closed, and its refused codes stay', () => {
    expect(empezarASalir({ fase: 'cerrando', rechazados: ['A'] })).toEqual({ fase: 'cerrando', rechazados: ['A'] })
    expect(empezarASalir({ fase: 'cerrada', rechazados: ['A'] })).toEqual({ fase: 'cerrada', rechazados: ['A'] })
  })
})

describe('terminarDeSalir', () => {
  describe('when the leaving action worked', () => {
    it('goes on to leave when no code was refused', () => {
      expect(terminarDeSalir(cerrando, true)).toEqual({
        estado: { fase: 'cerrada', rechazados: [] }, navegar: true, sinGuardar: [],
      })
    })

    it('does NOT leave while a refused code has not been acknowledged: the screen is held, with the codes to tell', () => {
      expect(terminarDeSalir({ fase: 'cerrando', rechazados: ['A', 'B'] }, true)).toEqual({
        estado: { fase: 'cerrada', rechazados: ['A', 'B'] }, navegar: false, sinGuardar: ['A', 'B'],
      })
    })
  })

  describe('when the leaving action did not work', () => {
    it('opens the screen to scans again, and stays', () => {
      expect(terminarDeSalir(cerrando, false)).toEqual({ estado: RECEPCION_ABIERTA, navegar: false, sinGuardar: [] })
    })

    it('gives back the refused codes to be told with the failure: the recepción is still open and they can be scanned again', () => {
      expect(terminarDeSalir({ fase: 'cerrando', rechazados: ['A'] }, false)).toEqual({
        estado: RECEPCION_ABIERTA, navegar: false, sinGuardar: ['A'],
      })
    })
  })

  it('does not depend on the screen having been told it was closing: with no refused code, a leaving action that worked leaves', () => {
    expect(terminarDeSalir(RECEPCION_ABIERTA, true)).toEqual({ estado: { fase: 'cerrada', rechazados: [] }, navegar: true, sinGuardar: [] })
    expect(terminarDeSalir(RECEPCION_ABIERTA, false)).toEqual({ estado: RECEPCION_ABIERTA, navegar: false, sinGuardar: [] })
  })
})

describe('the texts', () => {
  it('names the code the strip refuses', () => {
    expect(textoDeRechazo('1Z999')).toBe('No se guardó 1Z999: llegó mientras se cerraba la recepción.')
  })

  it('says what to do about one code that was not saved, with the way back', () => {
    expect(textoDeNoGuardados(['1Z999']))
      .toBe('No se guardó 1Z999: llegó mientras se cerraba la recepción. Volvé a Recepción y escanealo de nuevo.')
  })

  it('names every code when there are several, and counts them', () => {
    expect(textoDeNoGuardados(['A', 'B', 'C']))
      .toBe('No se guardaron 3 códigos: A, B, C. Llegaron mientras se cerraba la recepción. Volvé a Recepción y escanealos de nuevo.')
  })

  it('adds the codes that were not saved to the failure that kept the operario on the screen', () => {
    expect(agregarNoGuardados('Odoo no respondió.', ['A'])).toBe('Odoo no respondió. No se guardó A: escanealo de nuevo.')
    expect(agregarNoGuardados('Odoo no respondió.', ['A', 'B'])).toBe('Odoo no respondió. No se guardaron 2 códigos (A, B): escanealos de nuevo.')
  })

  it('leaves the failure as it is when no code was refused', () => {
    expect(agregarNoGuardados('Odoo no respondió.', [])).toBe('Odoo no respondió.')
  })
})

describe('the sequence of the finding', () => {
  it('a code fired after Enviar is not sent and is not lost: the screen stays until it has been seen', () => {
    // A scan before the tap goes to the server as it always did.
    let estado = RECEPCION_ABIERTA
    expect(decidirEscaneo(estado, 'ANTES').despachar).toBe(true)

    // The tap on Enviar, and then the gun fires.
    estado = empezarASalir(estado)
    const despues = decidirEscaneo(estado, 'DESPUES')
    expect(despues.despachar).toBe(false)

    // Enviar worked: the screen does not leave with 'DESPUES' unsaid. Another code fired meanwhile joins it.
    const fin = terminarDeSalir(despues.estado, true)
    expect(fin.navegar).toBe(false)
    expect(fin.sinGuardar).toEqual(['DESPUES'])
    const otro = decidirEscaneo(fin.estado, 'OTRO')
    expect(otro.despachar).toBe(false)
    expect(otro.estado.rechazados).toEqual(['DESPUES', 'OTRO'])
    expect(textoDeNoGuardados(otro.estado.rechazados)).toContain('DESPUES, OTRO')
  })

  it('a code fired while Enviar fails is told with the failure, and scanning goes on', () => {
    const refusal = decidirEscaneo(empezarASalir(RECEPCION_ABIERTA), 'DESPUES')

    const fin = terminarDeSalir(refusal.estado, false)

    expect(fin.navegar).toBe(false)
    expect(agregarNoGuardados('Odoo no respondió.', fin.sinGuardar)).toContain('DESPUES')
    expect(decidirEscaneo(fin.estado, 'DE_NUEVO').despachar).toBe(true)
  })
})
