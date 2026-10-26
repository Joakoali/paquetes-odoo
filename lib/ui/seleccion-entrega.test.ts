import { describe, expect, it } from 'vitest'
import type { LineaEntrega } from '@/lib/odoo/pickings'
import {
  alternarLinea, filtrarBarcos, puedeConfirmar, resumenSeleccion, textoDeAvisoSinEnviar, textoDeEnviandose, textoDeEspera, textoDeLinea,
  textoDeSeleccion, textoDeSiguiente, textoDeSinEnviar, textoSinPaquetes,
} from './seleccion-entrega'

const l = (moveLineId: number, pickingId: number, datos: Partial<LineaEntrega> = {}): LineaEntrega => ({
  moveLineId, pickingId, pickingRef: `MB92/OUT/${pickingId}`, trackingNumber: `T${moveLineId}`, courierNombre: 'DHL', ...datos,
})

describe('resumenSeleccion', () => {
  it('summarises chosen lines and the pickings they belong to', () => {
    const lineas = [l(1, 700), l(2, 700), l(3, 701)]
    expect(resumenSeleccion(lineas, new Set([1, 3]))).toEqual({ total: 3, elegidas: 2, pickingIds: [700, 701], moveLineIds: [1, 3] })
  })

  it('lists each picking once, in the order its first chosen line appears', () => {
    const lineas = [l(1, 701), l(2, 700), l(3, 701), l(4, 700)]
    expect(resumenSeleccion(lineas, new Set([1, 2, 3, 4]))).toMatchObject({ pickingIds: [701, 700], moveLineIds: [1, 2, 3, 4] })
  })

  it('leaves out the picking of which no line is chosen: it is not touched', () => {
    const lineas = [l(1, 700), l(2, 701)]
    expect(resumenSeleccion(lineas, new Set([2]))).toEqual({ total: 2, elegidas: 1, pickingIds: [701], moveLineIds: [2] })
  })

  it('keeps the order of the lines, not the order in which they were chosen', () => {
    const lineas = [l(1, 700), l(2, 700), l(3, 700)]
    expect(resumenSeleccion(lineas, new Set([3, 1])).moveLineIds).toEqual([1, 3])
  })

  it('counts only lines that are on the list: an id left over from a line that went away is not a package', () => {
    const lineas = [l(1, 700)]
    expect(resumenSeleccion(lineas, new Set([1, 99]))).toEqual({ total: 1, elegidas: 1, pickingIds: [700], moveLineIds: [1] })
  })

  it('is empty when nothing is chosen, and when there is nothing to choose', () => {
    expect(resumenSeleccion([l(1, 700)], new Set())).toEqual({ total: 1, elegidas: 0, pickingIds: [], moveLineIds: [] })
    expect(resumenSeleccion([], new Set())).toEqual({ total: 0, elegidas: 0, pickingIds: [], moveLineIds: [] })
  })
})

describe('alternarLinea', () => {
  it('takes a chosen line out', () => {
    expect([...alternarLinea(new Set([1, 2, 3]), 2)]).toEqual([1, 3])
  })

  it('puts a line that is out back in', () => {
    expect([...alternarLinea(new Set([1, 3]), 2)].sort()).toEqual([1, 2, 3])
  })

  it('does not change the set it was given: React state is not mutated', () => {
    const antes = new Set([1, 2])
    const despues = alternarLinea(antes, 2)

    expect([...antes]).toEqual([1, 2])
    expect(despues).not.toBe(antes)
  })
})

describe('textoDeSeleccion', () => {
  it('says how many of the packages are delivered', () => {
    expect(textoDeSeleccion({ elegidas: 11, total: 12 })).toBe('Se entregan 11 de 12')
  })

  it('says it also when all of them are', () => {
    expect(textoDeSeleccion({ elegidas: 3, total: 3 })).toBe('Se entregan 3 de 3')
  })
})

describe('textoDeSiguiente', () => {
  it('names the next step and how many packages go to it', () => {
    expect(textoDeSiguiente(11)).toBe('Siguiente: firma · 11 paquetes')
  })

  it('says package, not packages, for one', () => {
    expect(textoDeSiguiente(1)).toBe('Siguiente: firma · 1 paquete')
  })

  it('asks for a package when none is chosen: there is no next step', () => {
    expect(textoDeSiguiente(0)).toBe('Elegí al menos un paquete')
  })
})

describe('textoDeSinEnviar', () => {
  it('is the warning of the barco row', () => {
    expect(textoDeSinEnviar(3)).toBe('+3 sin enviar a Odoo')
  })

  it('is nothing when there is nothing unsent', () => {
    expect(textoDeSinEnviar(0)).toBeNull()
  })
})

describe('textoDeAvisoSinEnviar', () => {
  it('says how many packages of the barco are received and not in Odoo', () => {
    expect(textoDeAvisoSinEnviar(3)).toBe('Hay 3 paquetes de este barco recibidos pero sin enviar a Odoo')
  })

  it('agrees with a single package', () => {
    expect(textoDeAvisoSinEnviar(1)).toBe('Hay 1 paquete de este barco recibido pero sin enviar a Odoo')
  })
})

describe('textoDeLinea', () => {
  it('is the tracking number, with its courier apart', () => {
    expect(textoDeLinea(l(1, 700, { trackingNumber: '1Z84X0E06811549362', courierNombre: 'UPS' })))
      .toEqual({ codigo: '1Z84X0E06811549362', courier: 'UPS' })
  })

  it('says "sin número" for a line without one, with the courier in the text and not apart', () => {
    expect(textoDeLinea(l(1, 700, { trackingNumber: null, courierNombre: 'UPS (incorrecto)' })))
      .toEqual({ codigo: 'UPS (incorrecto) · sin número', courier: null })
  })
})

describe('textoDeEspera', () => {
  const ahora = new Date('2026-10-26T12:00:00Z')
  const haceMs = (ms: number) => new Date(ahora.getTime() - ms)
  const HORA = 3_600_000

  it('says since when the oldest delivery of the barco has been waiting', () => {
    expect(textoDeEspera(haceMs(3 * HORA), ahora)).toBe('desde hace 3 h')
    expect(textoDeEspera(haceMs(5 * 24 * HORA), ahora)).toBe('desde hace 5 días')
    expect(textoDeEspera(haceMs(25 * HORA), ahora)).toBe('desde ayer')
  })

  it('says that it just came in, instead of "desde recién"', () => {
    expect(textoDeEspera(haceMs(10_000), ahora)).toBe('llegó recién')
  })

  it('says that Odoo has nothing yet for a barco that has only unsent packages', () => {
    expect(textoDeEspera(null, ahora)).toBe('nada en Odoo todavía')
  })
})

describe('filtrarBarcos', () => {
  const barcos = [{ barcoEtiqueta: 'MAYANQUEEN' }, { barcoEtiqueta: 'Arctic' }, { barcoEtiqueta: 'Estrella del Mar' }, { barcoEtiqueta: 'H3' }]

  it('gives them all back for an empty field, or one with only blanks', () => {
    expect(filtrarBarcos(barcos, '')).toEqual(barcos)
    expect(filtrarBarcos(barcos, '   ')).toEqual(barcos)
  })

  it('keeps those whose name contains what was typed, whatever the case, from the first letter', () => {
    expect(filtrarBarcos(barcos, 'a')).toEqual([{ barcoEtiqueta: 'MAYANQUEEN' }, { barcoEtiqueta: 'Arctic' }, { barcoEtiqueta: 'Estrella del Mar' }])
    expect(filtrarBarcos(barcos, 'queen')).toEqual([{ barcoEtiqueta: 'MAYANQUEEN' }])
  })

  it('does not mind accents, nor the blanks around the text', () => {
    expect(filtrarBarcos([{ barcoEtiqueta: 'Águila' }], '  aguila ')).toEqual([{ barcoEtiqueta: 'Águila' }])
    expect(filtrarBarcos([{ barcoEtiqueta: 'Aguila' }], 'ÁGU')).toEqual([{ barcoEtiqueta: 'Aguila' }])
  })

  it('keeps the blanks inside: a name can have them', () => {
    expect(filtrarBarcos(barcos, 'del mar')).toEqual([{ barcoEtiqueta: 'Estrella del Mar' }])
  })

  it('takes what is typed as text and not as a pattern', () => {
    expect(filtrarBarcos(barcos, '.*')).toEqual([])
  })

  it('goes by what the list shows of each barco, so that two with the same name can be told apart by their id', () => {
    const gemelos = [{ barcoEtiqueta: 'H3 · #1234' }, { barcoEtiqueta: 'MAYANQUEEN' }, { barcoEtiqueta: 'H3 · #1301' }]

    expect(filtrarBarcos(gemelos, 'h3')).toEqual([{ barcoEtiqueta: 'H3 · #1234' }, { barcoEtiqueta: 'H3 · #1301' }])
    expect(filtrarBarcos(gemelos, '#1301')).toEqual([{ barcoEtiqueta: 'H3 · #1301' }])
    expect(filtrarBarcos(gemelos, 'h3 · #1234')).toEqual([{ barcoEtiqueta: 'H3 · #1234' }])
  })

  it('is empty when no name matches, and it keeps the order of the list', () => {
    expect(filtrarBarcos(barcos, 'zzz')).toEqual([])
    expect(filtrarBarcos(barcos, 'r').map((barco) => barco.barcoEtiqueta)).toEqual(['Arctic', 'Estrella del Mar'])
  })
})

describe('puedeConfirmar', () => {
  const firma = 'data:image/png;base64,AAAA'

  it('needs a name, a signature and a package', () => {
    expect(puedeConfirmar({ receptor: 'Tom Baker', firma, elegidas: 2 })).toBe(true)
  })

  it('does not take a name of blanks as a name', () => {
    expect(puedeConfirmar({ receptor: '   ', firma, elegidas: 2 })).toBe(false)
    expect(puedeConfirmar({ receptor: '', firma, elegidas: 2 })).toBe(false)
  })

  it('needs the signature', () => {
    expect(puedeConfirmar({ receptor: 'Tom', firma: null, elegidas: 2 })).toBe(false)
  })

  it('needs at least one package', () => {
    expect(puedeConfirmar({ receptor: 'Tom', firma, elegidas: 0 })).toBe(false)
  })
})

describe('textoDeEnviandose', () => {
  it('says how many packages of the barco are already in an entrega that is on its way to Odoo', () => {
    expect(textoDeEnviandose(3)).toBe('3 paquetes ya entregados, enviándose a Odoo')
  })

  it('agrees with a single package', () => {
    expect(textoDeEnviandose(1)).toBe('1 paquete ya entregado, enviándose a Odoo')
  })
})

describe('textoSinPaquetes', () => {
  it('says Odoo has nothing waiting when no package is on its way either', () => {
    expect(textoSinPaquetes(0)).toBe('Odoo no tiene paquetes esperando entrega para este barco.')
  })

  it('says there are no more to deliver when the ones left out are on their way to Odoo', () => {
    expect(textoSinPaquetes(2)).toBe('No quedan más paquetes para entregar.')
  })
})
