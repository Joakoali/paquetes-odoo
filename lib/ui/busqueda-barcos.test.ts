import { describe, expect, it } from 'vitest'
import { contadorDePedidos, ESPERA_MS, LETRAS_MINIMAS, textoABuscar } from './busqueda-barcos'

describe('the search of barcos', () => {
  it('waits 200 ms after the last key and starts from 2 letters', () => {
    expect(ESPERA_MS).toBe(200)
    expect(LETRAS_MINIMAS).toBe(2)
  })
})

describe('textoABuscar', () => {
  it('is what was typed, from 2 letters', () => {
    expect(textoABuscar('h3')).toBe('h3')
    expect(textoABuscar('Gaja')).toBe('Gaja')
  })

  it('is nothing for an empty field or a single letter', () => {
    expect(textoABuscar('')).toBeNull()
    expect(textoABuscar('h')).toBeNull()
  })

  it('does not count the blanks at the ends, and does not search with them', () => {
    expect(textoABuscar('  h ')).toBeNull()
    expect(textoABuscar('   ')).toBeNull()
    expect(textoABuscar('  h3 ')).toBe('h3')
  })

  it('keeps what is inside: a name with a space is searched as it was typed', () => {
    expect(textoABuscar('mayan queen')).toBe('mayan queen')
  })
})

describe('contadorDePedidos', () => {
  it('is current while no other request has been made', () => {
    const pedidos = contadorDePedidos()

    const primero = pedidos.nuevo()

    expect(pedidos.esVigente(primero)).toBe(true)
  })

  it('makes the answer of an older request stale as soon as a newer one is made', () => {
    const pedidos = contadorDePedidos()

    const viejo = pedidos.nuevo()
    const nuevo = pedidos.nuevo()

    expect(pedidos.esVigente(viejo)).toBe(false)
    expect(pedidos.esVigente(nuevo)).toBe(true)
  })

  it('keeps only the last one current, however many were made', () => {
    const pedidos = contadorDePedidos()

    const todos = [pedidos.nuevo(), pedidos.nuevo(), pedidos.nuevo(), pedidos.nuevo()]

    expect(todos.map((pedido) => pedidos.esVigente(pedido))).toEqual([false, false, false, true])
  })

  it('has requests that never repeat, so that an old answer cannot pass for a current one', () => {
    const pedidos = contadorDePedidos()

    const numeros = new Set(Array.from({ length: 100 }, () => pedidos.nuevo()))

    expect(numeros.size).toBe(100)
  })

  it('is independent of the others: each field has its own count', () => {
    const uno = contadorDePedidos()
    const otro = contadorDePedidos()

    const delUno = uno.nuevo()
    otro.nuevo()
    otro.nuevo()

    expect(uno.esVigente(delUno)).toBe(true)
  })
})
