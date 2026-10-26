import { describe, expect, it } from 'vitest'
import { ErrorParaOperario } from '@/lib/errores'
import type { LineaEntrega } from '@/lib/odoo/pickings'
import { PAQUETES_YA_NO_PENDIENTES, resolverElegidas } from './lineas'

const linea = (moveLineId: number, pickingId = 700): LineaEntrega => ({
  moveLineId, pickingId, pickingRef: `MB92/OUT/00${pickingId}`, trackingNumber: `T${moveLineId}`, courierNombre: 'DHL',
})

/** What Odoo has waiting for the barco: two lines of delivery 700 and one of delivery 701. */
const pendientes = [linea(11), linea(12), linea(21, 701)]

describe('resolverElegidas', () => {
  it('gives the lines asked for, in the order Odoo lists them, and the deliveries they are on, each once', () => {
    expect(resolverElegidas({ pedidas: [21, 12, 11], pendientes })).toEqual({ moveLineIds: [11, 12, 21], pickingIds: [700, 701] })
  })

  it('leaves out the deliveries none of whose lines was asked for', () => {
    expect(resolverElegidas({ pedidas: [21], pendientes })).toEqual({ moveLineIds: [21], pickingIds: [701] })
  })

  it('takes a line listed twice once', () => {
    expect(resolverElegidas({ pedidas: [11, 11], pendientes })).toEqual({ moveLineIds: [11], pickingIds: [700] })
  })

  it.each([
    ['a line Odoo does not list', [11, 555]],
    ['only lines Odoo does not list', [555]],
    ['an id that is not a number', ['11']],
    ['an id that is not a whole number', [11.5]],
    ['null', [null]],
    ['an object', [{ moveLineId: 11 }]],
  ])('says the packages are no longer waiting when it is asked for %s', (_caso, pedidas) => {
    const error = (() => {
      try {
        resolverElegidas({ pedidas, pendientes })
      } catch (e) {
        return e
      }
    })()

    expect(error).toBeInstanceOf(ErrorParaOperario)
    expect((error as Error).message).toBe(PAQUETES_YA_NO_PENDIENTES)
  })

  it('says it too when Odoo has nothing waiting', () => {
    expect(() => resolverElegidas({ pedidas: [11], pendientes: [] })).toThrow(PAQUETES_YA_NO_PENDIENTES)
  })

  it('says it for what is not a list of ids at all', () => {
    for (const pedidas of [undefined, null, 11, 'abc', {}]) {
      expect(() => resolverElegidas({ pedidas, pendientes })).toThrow(PAQUETES_YA_NO_PENDIENTES)
    }
  })

  it('asks for nothing: it gives nothing, and it is for the caller to say that a delivery needs something to deliver', () => {
    expect(resolverElegidas({ pedidas: [], pendientes })).toEqual({ moveLineIds: [], pickingIds: [] })
  })
})
