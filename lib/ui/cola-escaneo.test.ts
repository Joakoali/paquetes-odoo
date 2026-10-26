import { describe, expect, it } from 'vitest'
import type { PaqueteEscaneado, ResultadoEscaneo } from '@/lib/recepcion/recepciones'
import {
  claveNueva, colaReducer, contarFilas, filasIniciales, normalizarCodigo, rotuloDeLaLista, textoDePaquetes,
  type AccionCola, type FilaEscaneo,
} from './cola-escaneo'

/** The operario scanned `trackingNumber` under a courier (DHL unless said otherwise): the row appears at once. */
const esc = (clave: string, trackingNumber: string, courier = { id: 1, nombre: 'DHL' }): AccionCola => ({
  tipo: 'escaneado', clave, trackingNumber, courierId: courier.id, courierNombre: courier.nombre,
})

const paquete = (trackingNumber: string, id: string, datos: Partial<PaqueteEscaneado> = {}): PaqueteEscaneado => ({
  id, trackingNumber, courierId: 1, courierNombre: 'DHL', estado: 'ok', duplicadoRef: null, ...datos,
})

const agregado = (trackingNumber: string, id: string, datos: Partial<PaqueteEscaneado> = {}): ResultadoEscaneo => ({
  tipo: 'agregado', paquete: paquete(trackingNumber, id, datos),
})

const repetido = (trackingNumber: string, donde = 'esta recepción'): ResultadoEscaneo => ({
  tipo: 'repetido', trackingNumber, donde,
})

const resuelto = (clave: string, resultado: ResultadoEscaneo): AccionCola => ({ tipo: 'resuelto', clave, resultado })

/** The rows after the actions, from an empty list. */
const aplicar = (...acciones: AccionCola[]): FilaEscaneo[] => acciones.reduce(colaReducer, [] as FilaEscaneo[])

/** What the operario reads of a row: the code and where it stands. */
const resumen = (filas: FilaEscaneo[]) => filas.map((fila) => [fila.trackingNumber, fila.estado])

describe('colaReducer', () => {
  describe('a scan', () => {
    it('appears at once as a verifying row, on top, with the courier it was scanned under', () => {
      const filas = aplicar(esc('a', 'T1', { id: 7, nombre: 'GLS' }))

      expect(filas).toEqual([{
        clave: 'a', trackingNumber: 'T1', courierId: 7, courierNombre: 'GLS',
        estado: 'verificando', detalle: null, itemId: null,
      }])
    })

    it('keeps every rapid scan as its own row while earlier ones are still verifying', () => {
      let f = colaReducer([], esc('a', 'T1'))
      f = colaReducer(f, esc('b', 'T2'))
      f = colaReducer(f, esc('c', 'T3'))
      f = colaReducer(f, resuelto('b', agregado('T2', 'i2')))

      expect(f.map((x) => [x.trackingNumber, x.estado])).toEqual([['T3', 'verificando'], ['T2', 'ok'], ['T1', 'verificando']])
    })

    it('puts the newest on top, above the rows that were already there', () => {
      const filas = colaReducer(filasIniciales([paquete('VIEJO', 'i0')]), esc('a', 'NUEVO'))

      expect(resumen(filas)).toEqual([['NUEVO', 'verificando'], ['VIEJO', 'ok']])
    })

    it('keeps two scans of the same code apart: each has its own row until the server answers', () => {
      // The gun can fire twice at the same label. The first one is added and the second one is "repetido".
      const filas = aplicar(esc('a', 'T1'), esc('b', 'T1'))

      expect(filas.map((fila) => [fila.clave, fila.estado])).toEqual([['b', 'verificando'], ['a', 'verificando']])
    })
  })

  describe('an answer', () => {
    it('settles its own row where it is, and leaves the order of the others alone', () => {
      const filas = aplicar(
        esc('a', 'T1'), esc('b', 'T2'), esc('c', 'T3'),
        resuelto('a', agregado('T1', 'i1')),
        resuelto('c', agregado('T3', 'i3')),
      )

      expect(resumen(filas)).toEqual([['T3', 'ok'], ['T2', 'verificando'], ['T1', 'ok']])
    })

    it('lets the answers come in any order: each lands on its own row', () => {
      const filas = aplicar(
        esc('a', 'T1'), esc('b', 'T2'), esc('c', 'T3'),
        resuelto('c', agregado('T3', 'i3')),
        resuelto('a', agregado('T1', 'i1')),
        resuelto('b', agregado('T2', 'i2')),
      )

      expect(filas.map((fila) => [fila.trackingNumber, fila.itemId])).toEqual([['T3', 'i3'], ['T2', 'i2'], ['T1', 'i1']])
    })

    it('gives an added package the id the server gave it, to be able to delete it', () => {
      const [fila] = aplicar(esc('a', 'T1'), resuelto('a', agregado('T1', 'item-9')))

      expect(fila).toMatchObject({ estado: 'ok', itemId: 'item-9', detalle: null })
    })

    it('marks an agregado duplicado row with its Odoo reference', () => {
      const [fila] = aplicar(
        esc('a', 'T1'),
        resuelto('a', agregado('T1', 'i1', { estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' })),
      )

      expect(fila).toMatchObject({ estado: 'duplicado', detalle: 'MB92/IN/00198', itemId: 'i1' })
    })

    it('marks a duplicado row whose reference is unknown without inventing one', () => {
      const [fila] = aplicar(esc('a', 'T1'), resuelto('a', agregado('T1', 'i1', { estado: 'duplicado', duplicadoRef: null })))

      expect(fila).toMatchObject({ estado: 'duplicado', detalle: null })
    })

    it('shows what the server stored: its code and courier', () => {
      const [fila] = aplicar(
        esc('a', 'T1', { id: 1, nombre: 'dhl' }),
        resuelto('a', agregado('T1', 'i1', { courierId: 1, courierNombre: 'DHL' })),
      )

      expect(fila).toMatchObject({ trackingNumber: 'T1', courierId: 1, courierNombre: 'DHL' })
    })

    it('a repetido result removes the provisional row', () => {
      const filas = aplicar(esc('a', 'T1'), resuelto('a', repetido('T1')))

      expect(filas).toEqual([])
    })

    it('a repetido result removes only its own row: the others, verifying or settled, stay', () => {
      const filas = aplicar(
        esc('a', 'T1'), resuelto('a', agregado('T1', 'i1')),
        esc('b', 'T2'),
        esc('c', 'T1'),
        resuelto('c', repetido('T1', 'la recepción de GAJA')),
      )

      expect(resumen(filas)).toEqual([['T2', 'verificando'], ['T1', 'ok']])
    })

    it('a failed scan stays with its error so it can be scanned again', () => {
      const filas = aplicar(esc('a', 'T1'), { tipo: 'fallido', clave: 'a', mensaje: 'No hubo respuesta del servidor.' })

      expect(filas).toEqual([{
        clave: 'a', trackingNumber: 'T1', courierId: 1, courierNombre: 'DHL',
        estado: 'error', detalle: 'No hubo respuesta del servidor.', itemId: null,
      }])
    })

    it('a failed scan does not touch the rows next to it', () => {
      const filas = aplicar(
        esc('a', 'T1'), esc('b', 'T2'), esc('c', 'T3'),
        resuelto('a', agregado('T1', 'i1')),
        { tipo: 'fallido', clave: 'b', mensaje: 'Esta recepción ya se envió a Odoo.' },
      )

      expect(resumen(filas)).toEqual([['T3', 'verificando'], ['T2', 'error'], ['T1', 'ok']])
    })

    it('scanning a failed code again replaces its failed row, so the list does not show it twice', () => {
      const filas = aplicar(
        esc('a', 'T1'), { tipo: 'fallido', clave: 'a', mensaje: 'Sin conexión' },
        esc('b', 'T1'),
      )

      expect(filas.map((fila) => [fila.clave, fila.estado])).toEqual([['b', 'verificando']])
    })

    it('scanning another code does not take away the failed row of this one', () => {
      const filas = aplicar(esc('a', 'T1'), { tipo: 'fallido', clave: 'a', mensaje: 'Sin conexión' }, esc('b', 'T2'))

      expect(resumen(filas)).toEqual([['T2', 'verificando'], ['T1', 'error']])
    })

    it('scanning a code again does not take away a row of it that was added: that is the "repetido" case', () => {
      const filas = aplicar(esc('a', 'T1'), resuelto('a', agregado('T1', 'i1')), esc('b', 'T1'))

      expect(resumen(filas)).toEqual([['T1', 'verificando'], ['T1', 'ok']])
    })

    it('ignores an answer for a row it does not have', () => {
      const antes = aplicar(esc('a', 'T1'))

      expect(colaReducer(antes, resuelto('x', agregado('T9', 'i9')))).toEqual(antes)
      expect(colaReducer(antes, resuelto('x', repetido('T9')))).toEqual(antes)
      expect(colaReducer(antes, { tipo: 'fallido', clave: 'x', mensaje: 'no' })).toEqual(antes)
    })
  })

  describe('borrado', () => {
    it('removes the row of that item', () => {
      const filas = aplicar(
        esc('a', 'T1'), resuelto('a', agregado('T1', 'i1')),
        esc('b', 'T2'), resuelto('b', agregado('T2', 'i2')),
        { tipo: 'borrado', itemId: 'i1' },
      )

      expect(resumen(filas)).toEqual([['T2', 'ok']])
    })

    it('removes nothing when no row has that item, and never the rows that have no item yet', () => {
      const filas = aplicar(esc('a', 'T1'), { tipo: 'fallido', clave: 'a', mensaje: 'no' }, esc('b', 'T2'))

      expect(colaReducer(filas, { tipo: 'borrado', itemId: 'otro' })).toEqual(filas)
    })
  })

  it('does not change the list it is given: it answers another one', () => {
    const antes = aplicar(esc('a', 'T1')).map((fila) => Object.freeze({ ...fila }))
    Object.freeze(antes)

    const despues = colaReducer(antes, resuelto('a', agregado('T1', 'i1')))

    expect(despues).not.toBe(antes)
    expect(antes[0].estado).toBe('verificando')
    expect(despues[0].estado).toBe('ok')
  })
})

describe('filasIniciales', () => {
  it('turns the packages of the recepción into rows, in the same order (the newest first)', () => {
    const filas = filasIniciales([
      paquete('T3', 'i3'),
      paquete('T2', 'i2', { estado: 'duplicado', duplicadoRef: 'MB92/IN/00198', courierId: 2, courierNombre: 'GLS' }),
      paquete('T1', 'i1'),
    ])

    expect(filas).toEqual([
      { clave: 'i3', trackingNumber: 'T3', courierId: 1, courierNombre: 'DHL', estado: 'ok', detalle: null, itemId: 'i3' },
      { clave: 'i2', trackingNumber: 'T2', courierId: 2, courierNombre: 'GLS', estado: 'duplicado', detalle: 'MB92/IN/00198', itemId: 'i2' },
      { clave: 'i1', trackingNumber: 'T1', courierId: 1, courierNombre: 'DHL', estado: 'ok', detalle: null, itemId: 'i1' },
    ])
  })

  it('is an empty list for a recepción with no packages', () => {
    expect(filasIniciales([])).toEqual([])
  })

  it('makes rows that can be deleted and that the reducer can work with', () => {
    const filas = colaReducer(filasIniciales([paquete('T1', 'i1'), paquete('T2', 'i2')]), { tipo: 'borrado', itemId: 'i1' })

    expect(resumen(filas)).toEqual([['T2', 'ok']])
  })
})

describe('normalizarCodigo', () => {
  it('normalizarCodigo trims and rejects empty codes', () => {
    expect(normalizarCodigo('  JJD1 \n')).toBe('JJD1')
    expect(normalizarCodigo('   ')).toBeNull()
  })

  it('rejects what is nothing but blanks of any kind, and the empty string', () => {
    expect(normalizarCodigo('')).toBeNull()
    expect(normalizarCodigo('\t\r\n ')).toBeNull()
  })

  it('takes away the blanks at both ends and changes nothing else: case, inner spaces and symbols stay', () => {
    expect(normalizarCodigo('\tjjd-00/39 abC\r\n')).toBe('jjd-00/39 abC')
  })
})

describe('contarFilas', () => {
  it('counts what will be sent, what is duplicated, what is being checked and what failed', () => {
    const filas = aplicar(
      esc('a', 'T1'), resuelto('a', agregado('T1', 'i1')),
      esc('b', 'T2'), resuelto('b', agregado('T2', 'i2')),
      esc('c', 'T3'), resuelto('c', agregado('T3', 'i3', { estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' })),
      esc('d', 'T4'),
      esc('e', 'T5'), { tipo: 'fallido', clave: 'e', mensaje: 'no' },
    )

    expect(contarFilas(filas)).toEqual({
      paraEnviar: 2, duplicados: 1, escaneados: 3, verificando: 1, conError: 1, enRecepcion: 4,
    })
  })

  it('is all zeros for an empty list', () => {
    expect(contarFilas([])).toEqual({ paraEnviar: 0, duplicados: 0, escaneados: 0, verificando: 0, conError: 0, enRecepcion: 0 })
  })
})

describe('textoDePaquetes', () => {
  it('says how many packages in the singular for one and in the plural for any other number', () => {
    expect(textoDePaquetes(0)).toBe('0 paquetes')
    expect(textoDePaquetes(1)).toBe('1 paquete')
    expect(textoDePaquetes(3)).toBe('3 paquetes')
  })
})

describe('rotuloDeLaLista', () => {
  /** The label of the list after some scans, as the screen holds it. */
  const rotulo = (...acciones: AccionCola[]) => rotuloDeLaLista(contarFilas(aplicar(...acciones)))

  it('counts what was scanned, the duplicados among them', () => {
    expect(rotulo(
      esc('a', 'T1'), resuelto('a', agregado('T1', 'i1')),
      esc('b', 'T2'), resuelto('b', agregado('T2', 'i2', { estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' })),
      esc('c', 'T3'), resuelto('c', agregado('T3', 'i3')),
      esc('d', 'T4'), resuelto('d', agregado('T4', 'i4')),
    )).toBe('Paquetes · 4 escaneados · 1 duplicado')
  })

  it('is just the count when everything is in order, in the singular for one', () => {
    expect(rotulo(esc('a', 'T1'), resuelto('a', agregado('T1', 'i1')))).toBe('Paquetes · 1 escaneado')
    expect(rotulo()).toBe('Paquetes · 0 escaneados')
  })

  it('says how many are being checked and how many did not get through', () => {
    expect(rotulo(
      esc('a', 'T1'), resuelto('a', agregado('T1', 'i1')),
      esc('b', 'T2'),
      esc('c', 'T3'), { tipo: 'fallido', clave: 'c', mensaje: 'Sin conexión' },
    )).toBe('Paquetes · 1 escaneado · 1 verificando · 1 con error')
  })

  it('puts the duplicados in the plural when there is more than one', () => {
    const duplicado = { estado: 'duplicado', duplicadoRef: null } as const
    expect(rotulo(
      esc('a', 'T1'), resuelto('a', agregado('T1', 'i1', duplicado)),
      esc('b', 'T2'), resuelto('b', agregado('T2', 'i2', duplicado)),
    )).toBe('Paquetes · 2 escaneados · 2 duplicados')
  })
})

describe('claveNueva', () => {
  it('gives a different key every time', () => {
    const claves = new Set(Array.from({ length: 200 }, () => claveNueva()))

    expect(claves.size).toBe(200)
  })

  it('still gives keys where crypto.randomUUID does not exist (a page opened over plain http)', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    try {
      const claves = new Set(Array.from({ length: 50 }, () => claveNueva()))
      expect(claves.size).toBe(50)
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original)
      else Reflect.deleteProperty(globalThis, 'crypto')
    }
  })
})
