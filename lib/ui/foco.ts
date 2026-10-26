import type { PointerEvent as EventoDePuntero } from 'react'

/*
 * The rules of the gun: it types the code and presses Enter, like a keyboard, so whatever has the focus when it
 * fires gets the code. The scan field must have it; no button may keep it (the Enter would press it); and the
 * on-screen keyboard must not open on the scan field. This is what the pieces of the screen use to keep to them.
 */

/**
 * For the `onPointerDown` of every button on a screen with a scan field. Touching a button then does not take the
 * focus from the field: the button does what it does on `click`, and the gun keeps typing where it was typing.
 */
export function noRobarFoco(evento: EventoDePuntero): void {
  evento.preventDefault()
}

/**
 * Whether `destino` is, or is inside, what `selector` says. The objects the browser gives as targets are asked by
 * duck typing, so this also works with the ones that are not elements (the document) and where there is no DOM.
 */
function estaDentroDe(destino: EventTarget | null, selector: string): boolean {
  const elemento = destino as { closest?: (selector: string) => unknown } | null
  return typeof elemento?.closest === 'function' && elemento.closest(selector) !== null
}

/**
 * Whether touching `destino` has to give the focus back to the scan field. Anywhere on the screen, except on
 * another input, text area or select: the operario is using that one (the filter of "Otro courier…", the almacén),
 * and taking the focus from it would make it impossible.
 */
export function debeRecuperarFoco(destino: EventTarget | null): boolean {
  return !estaDentroDe(destino, 'input, textarea, select')
}

/** Whether `destino` is a select, or inside one. */
export function esSelect(destino: EventTarget | null): boolean {
  return estaDentroDe(destino, 'select')
}

/**
 * The code in the field, and the field left empty, in the same call. Doing both without anything in between
 * is what keeps the next code of a gun that fires fast from being added to this one, or erased with it.
 */
export function tomarCodigo(campo: { value: string }): string {
  const codigo = campo.value
  campo.value = ''
  return codigo
}

/**
 * For the `onKeyDown` of a select that must not be changed by typing: a gun that fires while it has the focus
 * would otherwise choose an option with the first letters of the code, with nobody having touched it. Tab goes
 * through, so that the select is not a trap for somebody who uses a keyboard.
 */
export function ignorarTeclas(evento: { key: string; preventDefault(): void }): void {
  if (evento.key !== 'Tab') evento.preventDefault()
}
