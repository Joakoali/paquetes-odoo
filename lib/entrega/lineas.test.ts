import { describe, expect, it } from 'vitest'
import { ErrorParaOperario } from '@/lib/errores'
import type { LineaEntrega } from '@/lib/odoo/pickings'
import { PAQUETES_EN_ENVIO, PAQUETES_YA_NO_PENDIENTES, resolverElegidas, separarRetenidas } from './lineas'

const linea = (moveLineId: number, pickingId = 700): LineaEntrega => ({
  moveLineId, pickingId, pickingRef: `MB92/OUT/00${pickingId}`, trackingNumber: `T${moveLineId}`, courierNombre: 'DHL',
})

/** What Odoo has waiting for the barco: two lines of delivery 700 and one of delivery 701. */
const pendientes = [linea(11), linea(12), linea(21, 701)]

/** What the entrega keeps of a line of `linea`. */
const paquete = (moveLineId: number, pickingId = 700) => ({
  trackingNumber: `T${moveLineId}`, courierNombre: 'DHL', pickingRef: `MB92/OUT/00${pickingId}`,
})

/** The error a call throws, or undefined when it does not throw. */
function loQueLanza(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
}

describe('separarRetenidas', () => {
  it('leaves out the lines that an entrega on its way to Odoo already holds, and counts them', () => {
    const { disponibles, enviandose } = separarRetenidas(pendientes, new Set([12, 21]))

    expect(disponibles).toEqual([linea(11)])
    expect(enviandose).toBe(2)
  })

  it('keeps every line, in its order, when nothing is held', () => {
    expect(separarRetenidas(pendientes, new Set())).toEqual({ disponibles: pendientes, enviandose: 0 })
  })

  it('does not count a held line that Odoo no longer lists: it is not there to be offered or to be waiting', () => {
    expect(separarRetenidas(pendientes, new Set([11, 999]))).toEqual({ disponibles: [linea(12), linea(21, 701)], enviandose: 1 })
  })

  it('gives nothing to offer when every line is held', () => {
    expect(separarRetenidas(pendientes, new Set([11, 12, 21]))).toEqual({ disponibles: [], enviandose: 3 })
  })

  it('answers empty for an empty list', () => {
    expect(separarRetenidas([], new Set([11]))).toEqual({ disponibles: [], enviandose: 0 })
  })
})

describe('resolverElegidas', () => {
  const resolver = (pedidas: unknown, retenidas: ReadonlySet<number> = new Set()) =>
    resolverElegidas({ pedidas, pendientes, retenidas })

  it('gives the lines asked for, in the order Odoo lists them, and the deliveries they are on, each once', () => {
    expect(resolver([21, 12, 11])).toEqual({
      moveLineIds: [11, 12, 21], pickingIds: [700, 701], paquetes: [paquete(11), paquete(12), paquete(21, 701)],
    })
  })

  it('keeps what each line chosen is: its package, its courier and the delivery it is on, in the same order', () => {
    const conUnaSinNumero = [linea(11), { ...linea(31, 702), trackingNumber: null, courierNombre: 'UPS (incorrecto)' }]

    expect(resolverElegidas({ pedidas: [31, 11], pendientes: conUnaSinNumero, retenidas: new Set() }).paquetes).toEqual([
      paquete(11),
      { trackingNumber: null, courierNombre: 'UPS (incorrecto)', pickingRef: 'MB92/OUT/00702' },
    ])
  })

  it('leaves out the deliveries none of whose lines was asked for', () => {
    expect(resolver([21])).toEqual({ moveLineIds: [21], pickingIds: [701], paquetes: [paquete(21, 701)] })
  })

  it('takes a line listed twice once', () => {
    expect(resolver([11, 11])).toEqual({ moveLineIds: [11], pickingIds: [700], paquetes: [paquete(11)] })
  })

  it.each([
    ['a line Odoo does not list', [11, 555]],
    ['only lines Odoo does not list', [555]],
    ['an id that is not a number', ['11']],
    ['an id that is not a whole number', [11.5]],
    ['null', [null]],
    ['an object', [{ moveLineId: 11 }]],
  ])('says the packages are no longer waiting when it is asked for %s', (_caso, pedidas) => {
    const error = loQueLanza(() => resolver(pedidas))

    expect(error).toBeInstanceOf(ErrorParaOperario)
    expect((error as Error).message).toBe(PAQUETES_YA_NO_PENDIENTES)
  })

  it('says it too when Odoo has nothing waiting', () => {
    expect(() => resolverElegidas({ pedidas: [11], pendientes: [], retenidas: new Set() })).toThrow(PAQUETES_YA_NO_PENDIENTES)
  })

  it('says it for what is not a list of ids at all', () => {
    for (const pedidas of [undefined, null, 11, 'abc', {}]) {
      expect(() => resolver(pedidas)).toThrow(PAQUETES_YA_NO_PENDIENTES)
    }
  })

  it('asks for nothing: it gives nothing, and it is for the caller to say that a delivery needs something to deliver', () => {
    expect(resolver([])).toEqual({ moveLineIds: [], pickingIds: [], paquetes: [] })
  })

  describe('lines that an entrega on its way to Odoo already holds', () => {
    it('refuses one, with its own message: nothing is partly accepted', () => {
      const error = loQueLanza(() => resolver([11, 12], new Set([12])))

      expect(error).toBeInstanceOf(ErrorParaOperario)
      expect((error as Error).message).toBe(PAQUETES_EN_ENVIO)
    })

    it('refuses them all when every line asked for is held', () => {
      expect(() => resolver([11, 12], new Set([11, 12]))).toThrow(PAQUETES_EN_ENVIO)
    })

    it('accepts the lines that are not held, whatever else is', () => {
      expect(resolver([11], new Set([12, 21]))).toEqual({ moveLineIds: [11], pickingIds: [700], paquetes: [paquete(11)] })
    })

    it('says "no longer waiting" and not "on its way" for a line Odoo no longer lists, even if it is held', () => {
      expect(() => resolver([555], new Set([555]))).toThrow(PAQUETES_YA_NO_PENDIENTES)
    })
  })
})
