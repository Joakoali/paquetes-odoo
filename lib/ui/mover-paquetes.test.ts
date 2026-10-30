import { describe, expect, it } from 'vitest'
import { textoDeConfirmacion, textoDeElegirBarco, textoDeMoviendose, textoDeSeleccionAMover } from './mover-paquetes'

describe('the texts of moving packages to another barco', () => {
  it('heads the list with how many of the packages go', () => {
    expect(textoDeSeleccionAMover({ elegidas: 2, total: 12 })).toBe('Se mueven 2 de 12')
    expect(textoDeSeleccionAMover({ elegidas: 0, total: 3 })).toBe('Se mueven 0 de 3')
  })

  it('says what is missing on the button while no package is chosen, and how many go once one is', () => {
    expect(textoDeElegirBarco(0)).toBe('Elegí al menos un paquete')
    expect(textoDeElegirBarco(1)).toBe('Elegir el barco · 1 paquete')
    expect(textoDeElegirBarco(3)).toBe('Elegir el barco · 3 paquetes')
  })

  it('asks for the confirmation with what goes, from where and to where', () => {
    expect(textoDeConfirmacion({ paquetes: 2, origen: 'MAYANQUEEN', destino: 'ARCTIC' })).toBe('Mover 2 paquetes de MAYANQUEEN a ARCTIC')
    expect(textoDeConfirmacion({ paquetes: 1, origen: 'H3 · #935', destino: 'H3 · #942' })).toBe('Mover 1 paquete de H3 · #935 a H3 · #942')
  })

  it('says how many packages are on their way to a barco', () => {
    expect(textoDeMoviendose({ barcoOdooId: 674, barcoNombre: 'ARCTIC', paquetes: 1 })).toBe('1 paquete pasándose a ARCTIC')
    expect(textoDeMoviendose({ barcoOdooId: 674, barcoNombre: 'ARCTIC', paquetes: 4 })).toBe('4 paquetes pasándose a ARCTIC')
  })
})
