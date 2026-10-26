import type { PointerEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { debeRecuperarFoco, esSelect, ignorarTeclas, noRobarFoco, tomarCodigo } from './foco'

/**
 * An element that answers `closest` the way a real one does for the tags it is inside of: what the test needs
 * is the selector the module asks with, so the fake only knows the tags it is given.
 */
const elemento = (...etiquetas: string[]) => ({
  closest: (selector: string) => {
    const buscadas = selector.split(',').map((parte) => parte.trim())
    return etiquetas.some((etiqueta) => buscadas.includes(etiqueta)) ? {} : null
  },
}) as unknown as EventTarget

describe('noRobarFoco', () => {
  it('cancels the pointerdown, which is what keeps the button from taking the focus of the scan field', () => {
    const preventDefault = vi.fn()

    noRobarFoco({ preventDefault } as unknown as PointerEvent)

    expect(preventDefault).toHaveBeenCalledTimes(1)
  })
})

describe('debeRecuperarFoco', () => {
  it('is true for anything that is not a field: the page, a button, a row, a label', () => {
    expect(debeRecuperarFoco(elemento('body'))).toBe(true)
    expect(debeRecuperarFoco(elemento('button'))).toBe(true)
    expect(debeRecuperarFoco(elemento('li', 'ul', 'main'))).toBe(true)
  })

  it('is false when what was touched is another input, a text area or a select: somebody is using it', () => {
    expect(debeRecuperarFoco(elemento('input'))).toBe(false)
    expect(debeRecuperarFoco(elemento('textarea'))).toBe(false)
    expect(debeRecuperarFoco(elemento('select'))).toBe(false)
  })

  it('is true when the target is not an element at all (the document, a window)', () => {
    expect(debeRecuperarFoco(null)).toBe(true)
    expect(debeRecuperarFoco({} as EventTarget)).toBe(true)
  })
})

describe('esSelect', () => {
  it('is true for a select and for what is inside one, and false for anything else', () => {
    expect(esSelect(elemento('select'))).toBe(true)
    expect(esSelect(elemento('input'))).toBe(false)
    expect(esSelect(elemento('button'))).toBe(false)
    expect(esSelect(null)).toBe(false)
    expect(esSelect({} as EventTarget)).toBe(false)
  })
})

describe('tomarCodigo', () => {
  it('gives the text of the field and leaves the field empty, in the same call', () => {
    const campo = { value: 'JJD000390007840583' }

    expect(tomarCodigo(campo)).toBe('JJD000390007840583')
    expect(campo.value).toBe('')
  })

  it('gives what the field has even if it is only blanks, and clears those as well', () => {
    const campo = { value: '  ' }

    expect(tomarCodigo(campo)).toBe('  ')
    expect(campo.value).toBe('')
  })
})

describe('ignorarTeclas', () => {
  it.each(['Enter', 'ArrowDown', 'ArrowUp', ' ', 'a', '1', 'Escape'])('cancels the key %j, so a select does not choose by typing', (key) => {
    const preventDefault = vi.fn()

    ignorarTeclas({ key, preventDefault })

    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('lets Tab through, so that the select is not a trap for somebody using a keyboard', () => {
    const preventDefault = vi.fn()

    ignorarTeclas({ key: 'Tab', preventDefault })

    expect(preventDefault).not.toHaveBeenCalled()
  })
})
