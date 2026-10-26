import { describe, expect, it } from 'vitest'
import type { ResultadoAccion } from '@/lib/acciones'
import type { PaqueteEscaneado, RecepcionAbierta, ResultadoEscaneo } from '@/lib/recepcion/recepciones'
import {
  llevaMasDeUnDia, pasoTrasEscanearSinBarco, resumenDeAbierta, textoDeEnviarTodas, totalesParaEnviar,
} from './inicio-recepcion'

const HORA = 3_600_000
const MINUTO = 60_000
const ahora = new Date('2026-10-26T12:00:00Z')
const haceMs = (ms: number) => new Date(ahora.getTime() - ms)

const abierta = (datos: Partial<RecepcionAbierta> = {}): RecepcionAbierta => ({
  id: 'r1', barcoOdooId: 7, barcoNombre: 'MAYANQUEEN', paquetes: 3, duplicados: 0,
  porCourier: [{ nombre: 'DHL', cantidad: 2 }, { nombre: 'UPS', cantidad: 1 }], abiertaDesde: haceMs(HORA), ...datos,
})

describe('llevaMasDeUnDia', () => {
  it('is false for a recepción opened a few hours ago', () => {
    expect(llevaMasDeUnDia(haceMs(3 * HORA), ahora)).toBe(false)
  })

  it('is false one minute before the 24 hours', () => {
    expect(llevaMasDeUnDia(haceMs(24 * HORA - MINUTO), ahora)).toBe(false)
  })

  it('is false at exactly 24 hours: it has to be more than that', () => {
    expect(llevaMasDeUnDia(haceMs(24 * HORA), ahora)).toBe(false)
  })

  it('is true as soon as it is past the 24 hours', () => {
    expect(llevaMasDeUnDia(haceMs(24 * HORA + 1), ahora)).toBe(true)
  })

  it('is true for one that was left open days ago', () => {
    expect(llevaMasDeUnDia(haceMs(3 * 24 * HORA), ahora)).toBe(true)
  })

  it('is false for a date ahead of now: the clock of the database and the one of the app never agree exactly', () => {
    expect(llevaMasDeUnDia(new Date(ahora.getTime() + 5_000), ahora)).toBe(false)
  })
})

describe('totalesParaEnviar', () => {
  it('is nothing when there is nothing open', () => {
    expect(totalesParaEnviar([])).toEqual({ recepciones: 0, paquetes: 0 })
  })

  it('counts the recepciones that have a valid package, and the valid packages of them', () => {
    const abiertas = [abierta({ paquetes: 3 }), abierta({ id: 'r2', paquetes: 1 }), abierta({ id: 'r3', paquetes: 5 })]

    expect(totalesParaEnviar(abiertas)).toEqual({ recepciones: 3, paquetes: 9 })
  })

  it('leaves out a recepción with only duplicados: "Enviar todas" does not send it', () => {
    const abiertas = [abierta({ paquetes: 2 }), abierta({ id: 'r2', paquetes: 0, duplicados: 2, porCourier: [] })]

    expect(totalesParaEnviar(abiertas)).toEqual({ recepciones: 1, paquetes: 2 })
  })

  it('is nothing when every recepción has only duplicados', () => {
    const abiertas = [abierta({ paquetes: 0, duplicados: 1, porCourier: [] })]

    expect(totalesParaEnviar(abiertas)).toEqual({ recepciones: 0, paquetes: 0 })
  })
})

describe('textoDeEnviarTodas', () => {
  it('says how many recepciones and how many packages go', () => {
    expect(textoDeEnviarTodas({ recepciones: 3, paquetes: 9 })).toBe('Enviar las 3 a Odoo · 9 paquetes')
  })

  it('does not say "las 1": a single recepción is "la recepción"', () => {
    expect(textoDeEnviarTodas({ recepciones: 1, paquetes: 4 })).toBe('Enviar la recepción a Odoo · 4 paquetes')
  })

  it('writes "1 paquete" in the singular', () => {
    expect(textoDeEnviarTodas({ recepciones: 1, paquetes: 1 })).toBe('Enviar la recepción a Odoo · 1 paquete')
  })
})

describe('resumenDeAbierta', () => {
  it('lists the couriers with how many packages each has, in the order they come', () => {
    expect(resumenDeAbierta(abierta())).toBe('DHL 2 · UPS 1')
  })

  it('adds the duplicados, since somebody has to look at them', () => {
    expect(resumenDeAbierta(abierta({ duplicados: 1 }))).toBe('DHL 2 · UPS 1 · 1 duplicado')
    expect(resumenDeAbierta(abierta({ duplicados: 3 }))).toBe('DHL 2 · UPS 1 · 3 duplicados')
  })

  it('says there is nothing to send when the recepción has only duplicados', () => {
    expect(resumenDeAbierta(abierta({ paquetes: 0, duplicados: 2, porCourier: [] }))).toBe('nada para enviar · 2 duplicados')
  })
})

describe('pasoTrasEscanearSinBarco', () => {
  const paquete = (datos: Partial<PaqueteEscaneado> = {}): PaqueteEscaneado => ({
    id: 'i1', trackingNumber: '1Z84X0E06811549362', courierId: 1, courierNombre: 'UPS', estado: 'ok', duplicadoRef: null, ...datos,
  })
  const respondio = (resultado: ResultadoEscaneo): ResultadoAccion<{ sesionId: string; resultado: ResultadoEscaneo }> => ({
    ok: true, valor: { sesionId: 'sesion-1', resultado },
  })

  it('opens the recepción when the package went in', () => {
    expect(pasoTrasEscanearSinBarco(respondio({ tipo: 'agregado', paquete: paquete() }), 'MAYANQUEEN')).toEqual({
      paso: 'abrir', sesionId: 'sesion-1',
    })
  })

  it('opens it too for a duplicado: it went in, flagged, and that is what the operario has to see there', () => {
    const duplicado = paquete({ estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' })

    expect(pasoTrasEscanearSinBarco(respondio({ tipo: 'agregado', paquete: duplicado }), 'MAYANQUEEN')).toEqual({
      paso: 'abrir', sesionId: 'sesion-1',
    })
  })

  it('stays on the home for a code that is already in a recepción, telling where, with the recepción that was opened for it', () => {
    const paso = pasoTrasEscanearSinBarco(respondio({
      tipo: 'repetido', trackingNumber: '1Z84X0E06811549362', donde: 'la recepción de GAJA',
    }), 'MAYANQUEEN')

    expect(paso).toEqual({
      paso: 'quedarse',
      sesionId: 'sesion-1',
      respuesta: { tono: 'error', texto: 'Ya está en la recepción de GAJA', sonido: 'aviso' },
    })
  })

  it('names the barco when the code is already in the recepción of the barco that was chosen: "esta recepción" means nothing on the home', () => {
    const paso = pasoTrasEscanearSinBarco(respondio({
      tipo: 'repetido', trackingNumber: '1Z84X0E06811549362', donde: 'esta recepción',
    }), 'MAYANQUEEN')

    expect(paso).toEqual({
      paso: 'quedarse',
      sesionId: 'sesion-1',
      respuesta: { tono: 'error', texto: 'Ya está en la recepción de MAYANQUEEN', sonido: 'aviso' },
    })
  })

  it('shows the message of a failed action and keeps the code to try again', () => {
    const error = 'No hubo respuesta del servidor. Revisá la conexión y probá de nuevo.'

    expect(pasoTrasEscanearSinBarco({ ok: false, error }, 'MAYANQUEEN')).toEqual({ paso: 'fallo', mensaje: error })
  })
})
