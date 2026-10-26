// Types only: lib/recepcion/recepciones.ts reaches the database, which must not get into the client.
import type { ResultadoEscaneo } from '@/lib/recepcion/recepciones'

/**
 * What the strip under the scan field says about the last thing that happened, and which of the two sounds goes
 * with it. `neutro` is for what is still going on and has no sound.
 */
export interface Respuesta {
  tono: 'ok' | 'error' | 'neutro'
  texto: string
  sonido: 'ok' | 'aviso' | null
}

/** What a scan says when there is no courier to put the code under. */
export const SIN_COURIER = 'Elegí un courier antes de escanear.'

/** What is said of a package that Odoo already has, in the strip and in its row of the list. `ref` is where Odoo has it. */
export function textoDeDuplicado(ref: string | null): string {
  return `Duplicado: ya está en ${ref ?? 'Odoo'} · no se envía`
}

/**
 * The answer of the server to a scan, as the strip says it: green for a package that went in, red for the two
 * things the operario has to look at (a package Odoo already has, which went in but is not sent, and a code that
 * is already in a recepción, which did not go in).
 */
export function respuestaDeEscaneo(resultado: ResultadoEscaneo): Respuesta {
  if (resultado.tipo === 'repetido') {
    return { tono: 'error', texto: `Ya está en ${resultado.donde}`, sonido: 'aviso' }
  }

  const { paquete } = resultado
  if (paquete.estado === 'duplicado') {
    return { tono: 'error', texto: textoDeDuplicado(paquete.duplicadoRef), sonido: 'aviso' }
  }
  return {
    tono: 'ok',
    texto: `✓ ${paquete.trackingNumber} · ${paquete.courierNombre} — agregado`,
    sonido: 'ok',
  }
}

/** A failure, with the text already written for the operario (`textoDeFallo` and `llamarAccion` give it). */
export function respuestaDeFallo(mensaje: string): Respuesta {
  return { tono: 'error', texto: mensaje, sonido: 'aviso' }
}
