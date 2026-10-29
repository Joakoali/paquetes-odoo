import { describe, expect, it } from 'vitest'
import {
  coincideAlguno, coincideTracking, filtrarPorTracking, MAX_CARACTERES_BUSQUEDA, MIN_CARACTERES_BUSQUEDA, MIN_PARA_FILTRAR,
  mostrarFiltro, normalizarTracking, textoDeBusqueda, textoDelFiltro, valorDeLaDireccion,
} from './busqueda-tracking'

describe('normalizarTracking', () => {
  it('takes out every blank and lowers the case', () => {
    expect(normalizarTracking(' 1Z 999 AA1 ')).toBe('1z999aa1')
    expect(normalizarTracking('JJD\t0003')).toBe('jjd0003')
  })

  it('changes nothing else: a slash or a dash is part of the code', () => {
    expect(normalizarTracking('PAACK-12/34')).toBe('paack-12/34')
  })
})

describe('coincideTracking', () => {
  it('finds a tracking number by a part of it, the last digits included', () => {
    expect(coincideTracking('JJD000390007840588', '0588')).toBe(true)
    expect(coincideTracking('JJD000390007840588', 'jjd0003')).toBe(true)
    expect(coincideTracking('JJD000390007840588', '9999')).toBe(false)
  })

  it('does not mind the case or the blanks of either side', () => {
    expect(coincideTracking('1Z999AA10123456784', '1z 999')).toBe(true)
    expect(coincideTracking('1Z 999 AA1', '999aa')).toBe(true)
  })

  it('lets everything through when nothing was typed', () => {
    expect(coincideTracking('JJD000390007840588', '')).toBe(true)
    expect(coincideTracking('JJD000390007840588', '   ')).toBe(true)
    expect(coincideTracking(null, '')).toBe(true)
  })

  it('never finds a package without number by what was typed', () => {
    expect(coincideTracking(null, '0588')).toBe(false)
  })
})

describe('coincideAlguno', () => {
  it('finds a row when any of its packages has what was typed', () => {
    expect(coincideAlguno(['JJD0001', 'JJD0002'], '0002')).toBe(true)
    expect(coincideAlguno(['JJD0001', null], '0003')).toBe(false)
  })

  it('lets a row with no package through while nothing is typed: an old entrega has none to show', () => {
    expect(coincideAlguno([], '')).toBe(true)
    expect(coincideAlguno([], '0001')).toBe(false)
  })
})

describe('filtrarPorTracking', () => {
  const paquetes = [
    { id: 1, trackingNumber: 'JJD000390007840588' },
    { id: 2, trackingNumber: null },
    { id: 3, trackingNumber: '1Z999AA10123450588' },
    { id: 4, trackingNumber: 'XW297134737JF' },
  ]

  it('keeps the ones that have what was typed, in the order of the list', () => {
    expect(filtrarPorTracking(paquetes, '0588').map((paquete) => paquete.id)).toEqual([1, 3])
  })

  it('keeps every one, the ones without number too, while nothing is typed', () => {
    expect(filtrarPorTracking(paquetes, '')).toEqual(paquetes)
  })
})

describe('mostrarFiltro', () => {
  it('is there from a list of MIN_PARA_FILTRAR rows', () => {
    expect(MIN_PARA_FILTRAR).toBe(6)
    expect(mostrarFiltro(5, '')).toBe(false)
    expect(mostrarFiltro(6, '')).toBe(true)
  })

  it('is there, however short the list, when it was opened with a filter: it must be possible to take it away', () => {
    expect(mostrarFiltro(1, '0588')).toBe(true)
    expect(mostrarFiltro(0, '0588')).toBe(true)
  })
})

describe('textoDelFiltro', () => {
  it('says nothing while nothing is typed', () => {
    expect(textoDelFiltro({ visibles: 3, total: 3, buscado: '' })).toBeNull()
    expect(textoDelFiltro({ visibles: 3, total: 3, buscado: '  ' })).toBeNull()
  })

  it('says how many of the list it shows', () => {
    expect(textoDelFiltro({ visibles: 1, total: 23, buscado: '0588' })).toBe('Mostrando 1 de 23')
  })

  it('says that none has what was typed, as it was typed', () => {
    expect(textoDelFiltro({ visibles: 0, total: 23, buscado: ' 4567 ' })).toBe('Ningún paquete tiene «4567» en el tracking.')
  })
})

describe('valorDeLaDireccion', () => {
  it('is the q of the address without the blanks at its ends', () => {
    expect(valorDeLaDireccion(' JJD0001 ')).toBe('JJD0001')
  })

  it('is empty when there is none', () => {
    expect(valorDeLaDireccion(undefined)).toBe('')
    expect(valorDeLaDireccion('')).toBe('')
  })

  it('takes the first one when the address has it twice', () => {
    expect(valorDeLaDireccion(['JJD0001', 'JJD0002'])).toBe('JJD0001')
    expect(valorDeLaDireccion([])).toBe('')
  })

  it('cuts what is longer than any tracking number', () => {
    expect(valorDeLaDireccion('x'.repeat(200))).toHaveLength(MAX_CARACTERES_BUSQUEDA)
  })
})

describe('textoDeBusqueda', () => {
  it('is what was typed, normalized, from MIN_CARACTERES_BUSQUEDA characters', () => {
    expect(MIN_CARACTERES_BUSQUEDA).toBe(4)
    expect(textoDeBusqueda('0588')).toBe('0588')
    expect(textoDeBusqueda(' 1Z 999 ')).toBe('1z999')
  })

  it('is nothing for less: the blanks do not count', () => {
    expect(textoDeBusqueda('058')).toBeNull()
    expect(textoDeBusqueda(' 0 5 8 ')).toBeNull()
    expect(textoDeBusqueda('')).toBeNull()
  })
})
