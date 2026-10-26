import { describe, expect, it } from 'vitest'
import type { PaqueteEscaneado, ResultadoEscaneo } from '@/lib/recepcion/recepciones'
import { respuestaDeEscaneo, respuestaDeFallo, SIN_COURIER, textoDeDuplicado } from './respuesta-escaneo'

const paquete = (datos: Partial<PaqueteEscaneado> = {}): PaqueteEscaneado => ({
  id: 'i1', trackingNumber: '1Z84X0E06811549362', courierId: 1, courierNombre: 'UPS', estado: 'ok', duplicadoRef: null, ...datos,
})

const agregado = (datos: Partial<PaqueteEscaneado> = {}): ResultadoEscaneo => ({ tipo: 'agregado', paquete: paquete(datos) })

describe('respuestaDeEscaneo', () => {
  it('is green for a package that went in, with its code and courier', () => {
    expect(respuestaDeEscaneo(agregado())).toEqual({
      tono: 'ok',
      texto: '✓ 1Z84X0E06811549362 · UPS — agregado',
      sonido: 'ok',
    })
  })

  it('says what the server stored (its code and courier), not what was typed', () => {
    const respuesta = respuestaDeEscaneo(agregado({ trackingNumber: 'JJD1', courierNombre: 'DHL' }))

    expect(respuesta.texto).toBe('✓ JJD1 · DHL — agregado')
  })

  it('is red for a package Odoo already has, with the reference of the picking, and says it is not sent', () => {
    expect(respuestaDeEscaneo(agregado({ estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' }))).toEqual({
      tono: 'error',
      texto: 'Duplicado: ya está en MB92/IN/00198 · no se envía',
      sonido: 'aviso',
    })
  })

  it('does not invent a reference for a duplicado that has none', () => {
    const { texto } = respuestaDeEscaneo(agregado({ estado: 'duplicado', duplicadoRef: null }))

    expect(texto).toBe('Duplicado: ya está en Odoo · no se envía')
  })

  it('is red for a code that is already in this recepción', () => {
    expect(respuestaDeEscaneo({ tipo: 'repetido', trackingNumber: 'T1', donde: 'esta recepción' })).toEqual({
      tono: 'error',
      texto: 'Ya está en esta recepción',
      sonido: 'aviso',
    })
  })

  it('is red for a code that is in the recepción of another barco, and says which', () => {
    const { texto } = respuestaDeEscaneo({ tipo: 'repetido', trackingNumber: 'T1', donde: 'la recepción de GAJA' })

    expect(texto).toBe('Ya está en la recepción de GAJA')
  })
})

describe('textoDeDuplicado', () => {
  it('is what the strip and the row of a package that Odoo already has say, so that it is said the same way', () => {
    expect(textoDeDuplicado('MB92/IN/00198')).toBe('Duplicado: ya está en MB92/IN/00198 · no se envía')
    expect(textoDeDuplicado(null)).toBe('Duplicado: ya está en Odoo · no se envía')
  })
})

describe('respuestaDeFallo', () => {
  it('is red and gives the text the operario has to read, with the warning sound', () => {
    expect(respuestaDeFallo('Esta recepción ya se envió a Odoo.')).toEqual({
      tono: 'error',
      texto: 'Esta recepción ya se envió a Odoo.',
      sonido: 'aviso',
    })
  })
})

describe('SIN_COURIER', () => {
  it('tells the operario to choose a courier first', () => {
    expect(SIN_COURIER).toBe('Elegí un courier antes de escanear.')
  })
})
