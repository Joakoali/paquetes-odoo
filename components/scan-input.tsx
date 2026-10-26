'use client'

import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { normalizarCodigo } from '@/lib/ui/cola-escaneo'
import { debeRecuperarFoco, esSelect, noRobarFoco, tomarCodigo } from '@/lib/ui/foco'

/** What a screen can ask of its scan field. */
export interface ScanInputHandle {
  /** Gives the focus back to the field: after something that may have taken it (a courier, a delete, a notice). */
  enfocar(): void
}

/**
 * The field the barcode gun types into. The gun is a keyboard: it types the code and presses Enter, so whatever has
 * the focus when it fires gets the code. That is why this field takes the focus when it appears, takes it back on any
 * touch (except on another field), and does not open the on-screen keyboard (`inputMode="none"`).
 *
 * It is not controlled, on purpose. With Enter the code is taken and the field is cleared in the same event: the
 * gun may already be typing the next code, and clearing after an answer (or after a render) would erase it.
 * `onCodigo` gets the code without the blanks at its ends, and is not called for an empty field.
 *
 * "Escribir a mano" opens the on-screen keyboard for one code (a label that cannot be scanned, or a phone with no
 * gun); after that code the field goes back to `inputMode="none"`.
 *
 * `ref` is the one of React 19 (a prop, no `forwardRef`).
 */
export function ScanInput({ ref, onCodigo, deshabilitado = false }: {
  ref?: Ref<ScanInputHandle>
  onCodigo: (codigo: string) => void
  deshabilitado?: boolean
}) {
  const campo = useRef<HTMLInputElement>(null)
  const [aMano, setAMano] = useState(false)

  // preventScroll: the field is at the top, and a touch on a button far down a long list must not scroll back up to it.
  const enfocar = () => campo.current?.focus({ preventScroll: true })

  useImperativeHandle(ref, () => ({ enfocar }), [])

  // When the screen appears, and when the field is enabled again (a disabled field has no focus).
  useEffect(() => {
    if (!deshabilitado) enfocar()
  }, [deshabilitado])

  useEffect(() => {
    // A touch anywhere gives the focus back, unless it is on another field: somebody is using that one.
    const alSoltar = (evento: Event) => {
      if (debeRecuperarFoco(evento.target)) enfocar()
    }
    // A select (the almacén) is touched to open its list, so it keeps the focus then; once it has chosen, the focus
    // is not left on it, or on nothing: the next code of the gun would go there.
    const alElegirEnUnSelect = (evento: Event) => {
      if (esSelect(evento.target)) enfocar()
    }
    document.addEventListener('pointerup', alSoltar)
    document.addEventListener('change', alElegirEnUnSelect)
    return () => {
      document.removeEventListener('pointerup', alSoltar)
      document.removeEventListener('change', alElegirEnUnSelect)
    }
  }, [])

  /** Sets `inputMode` on the field itself and gives it the focus again, which is what makes a browser show or hide its keyboard. */
  function cambiarTeclado(modo: 'text' | 'none') {
    const elemento = campo.current
    if (!elemento) return
    elemento.inputMode = modo
    elemento.blur()
    elemento.focus({ preventScroll: true })
  }

  function escribirAMano() {
    setAMano(true)
    cambiarTeclado('text')
  }

  function alTeclear(evento: KeyboardEvent<HTMLInputElement>) {
    if (evento.key !== 'Enter') return
    evento.preventDefault()

    const codigo = normalizarCodigo(tomarCodigo(evento.currentTarget))
    if (aMano) {
      setAMano(false)
      cambiarTeclado('none')
    }
    if (codigo !== null) onCodigo(codigo)
  }

  return (
    <div className="scan">
      <div className="scan-campo">
        <span className="scan-barras" aria-hidden="true" />
        <input
          ref={campo}
          type="text"
          className="scan-input"
          aria-label="Código del paquete"
          placeholder="Listo para escanear con la pistola…"
          inputMode={aMano ? 'text' : 'none'}
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={deshabilitado}
          onKeyDown={alTeclear}
        />
      </div>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={deshabilitado}
        onPointerDown={noRobarFoco}
        onClick={escribirAMano}
      >
        Escribir a mano
      </button>
    </div>
  )
}
