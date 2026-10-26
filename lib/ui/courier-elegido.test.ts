import { describe, expect, it, vi } from 'vitest'
import {
  CLAVE_ULTIMO_COURIER, courierInicial, filtrarCouriers, guardarUltimoCourier, leerUltimoCourier,
} from './courier-elegido'

const dhl = { id: 1, nombre: 'DHL' }
const ups = { id: 2, nombre: 'UPS' }
const gls = { id: 3, nombre: 'GLS' }
const angel = { id: 4, nombre: 'Ángel Express' }
const royal = { id: 5, nombre: 'Royal Mail' }
const todos = [angel, dhl, gls, royal, ups]

/** A storage that remembers what it is given, like the one of a browser. */
function almacenamiento(inicial: Record<string, string> = {}) {
  const datos = new Map(Object.entries(inicial))
  return {
    getItem: vi.fn((clave: string) => datos.get(clave) ?? null),
    setItem: vi.fn((clave: string, valor: string) => { datos.set(clave, valor) }),
  }
}

/** A storage the browser will not open (a private window, blocked site data): everything throws. */
const almacenamientoRoto = () => ({
  getItem: vi.fn(() => { throw new Error('SecurityError') }),
  setItem: vi.fn(() => { throw new Error('QuotaExceededError') }),
})

describe('the remembered courier', () => {
  it('is kept under paqueteria:ultimoCourier', () => {
    expect(CLAVE_ULTIMO_COURIER).toBe('paqueteria:ultimoCourier')
  })

  it('is read back as what was saved', () => {
    const almacen = almacenamiento()

    guardarUltimoCourier(7, almacen)

    expect(almacen.setItem).toHaveBeenCalledWith('paqueteria:ultimoCourier', '7')
    expect(leerUltimoCourier(almacen)).toBe(7)
  })

  it('is null when nothing was saved', () => {
    expect(leerUltimoCourier(almacenamiento())).toBeNull()
  })

  it.each(['', 'abc', '7abc', '-3', '1.5', ' 7'])('is null for what is not an id (%j)', (valor) => {
    expect(leerUltimoCourier(almacenamiento({ [CLAVE_ULTIMO_COURIER]: valor }))).toBeNull()
  })

  it('is null, and does not throw, when the browser will not open its storage', () => {
    expect(leerUltimoCourier(almacenamientoRoto())).toBeNull()
  })

  it('is not saved, and does not throw, when the browser will not open its storage', () => {
    expect(() => guardarUltimoCourier(7, almacenamientoRoto())).not.toThrow()
  })

  it('is null, and does not throw, where there is no storage at all (the server, a page that has none)', () => {
    expect(leerUltimoCourier(null)).toBeNull()
    expect(() => guardarUltimoCourier(7, null)).not.toThrow()
  })
})

describe('courierInicial', () => {
  it('is the one used last, when it is one of the couriers', () => {
    expect(courierInicial([dhl, ups], todos, 3)).toEqual(gls)
  })

  it('is the first frequent one when nothing was used yet', () => {
    expect(courierInicial([dhl, ups], todos, null)).toEqual(dhl)
  })

  it('is the first frequent one when the one used last is not offered any more', () => {
    expect(courierInicial([dhl, ups], todos, 99)).toEqual(dhl)
  })

  it('is nobody when there are no couriers', () => {
    expect(courierInicial([], [], null)).toBeNull()
    expect(courierInicial([], [], 3)).toBeNull()
  })
})

describe('filtrarCouriers', () => {
  it('gives all of them, in the same order, when there is nothing to look for', () => {
    expect(filtrarCouriers(todos, '')).toEqual(todos)
    expect(filtrarCouriers(todos, '   ')).toEqual(todos)
  })

  it('keeps the couriers whose name has what was typed, whatever the case', () => {
    expect(filtrarCouriers(todos, 'ls')).toEqual([gls])
    expect(filtrarCouriers(todos, 'EXPR')).toEqual([angel])
  })

  it('does not tell accents apart, in either direction', () => {
    expect(filtrarCouriers(todos, 'angel')).toEqual([angel])
    expect(filtrarCouriers(todos, 'ÁNGEL')).toEqual([angel])
  })

  it('finds a word of the name that is not the first one', () => {
    expect(filtrarCouriers(todos, 'mail')).toEqual([royal])
  })

  it('is empty when nothing matches', () => {
    expect(filtrarCouriers(todos, 'zzz')).toEqual([])
  })
})
