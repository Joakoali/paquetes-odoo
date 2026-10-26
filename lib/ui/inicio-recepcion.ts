// Types only: these two modules reach the database, which must not get into the client.
import type { ResultadoAccion } from '@/lib/acciones'
import type { RecepcionAbierta, ResultadoEscaneo } from '@/lib/recepcion/recepciones'
import { textoDePaquetes } from './cola-escaneo'
import { respuestaDeEscaneo, type Respuesta } from './respuesta-escaneo'

/*
 * What the home of Recepción decides about what it shows, apart from how it looks: when an open recepción has been
 * forgotten, what "Enviar todas" says, and what to do with the answer of a scan made with no barco chosen.
 */

const HORA_MS = 3_600_000

/** A recepción that has been open longer than this is probably one that was forgotten, and its time is shown as a warning. */
export const HORAS_PARA_AVISAR = 24

/** Whether the recepción has been open for more than 24 hours (exactly 24 is not more). A date ahead of `ahora` is not. */
export function llevaMasDeUnDia(abiertaDesde: Date, ahora: Date): boolean {
  return ahora.getTime() - abiertaDesde.getTime() > HORAS_PARA_AVISAR * HORA_MS
}

export interface TotalesParaEnviar {
  /** The recepciones "Enviar todas" will send: the ones with at least one valid package. */
  recepciones: number
  /** The valid packages in them. */
  paquetes: number
}

/**
 * What "Enviar todas" sends, which is not everything that is open: a recepción with only duplicados has nothing to send
 * and stays open, so it is in neither number (`enviarRecepcionesAbiertas` leaves it as it is).
 */
export function totalesParaEnviar(abiertas: Pick<RecepcionAbierta, 'paquetes'>[]): TotalesParaEnviar {
  const conPaquetes = abiertas.filter((abierta) => abierta.paquetes > 0)
  return {
    recepciones: conPaquetes.length,
    paquetes: conPaquetes.reduce((suma, abierta) => suma + abierta.paquetes, 0),
  }
}

/** The text of the button: "Enviar las 3 a Odoo · 9 paquetes", and for a single recepción "Enviar la recepción a Odoo · 4 paquetes". */
export function textoDeEnviarTodas({ recepciones, paquetes }: TotalesParaEnviar): string {
  const cuales = recepciones === 1 ? 'la recepción' : `las ${recepciones}`
  return `Enviar ${cuales} a Odoo · ${textoDePaquetes(paquetes)}`
}

/**
 * What an open recepción says under the name of its barco, before how long it has been open: its couriers with how
 * many packages each, and the duplicados (somebody has to look at them). A recepción with only duplicados says that
 * there is nothing to send, since its count of packages is 0 and the couriers are none.
 */
export function resumenDeAbierta({ porCourier, duplicados }: Pick<RecepcionAbierta, 'porCourier' | 'duplicados'>): string {
  const partes = porCourier.map(({ nombre, cantidad }) => `${nombre} ${cantidad}`)
  if (partes.length === 0) partes.push('nada para enviar')
  if (duplicados > 0) partes.push(`${duplicados} ${duplicados === 1 ? 'duplicado' : 'duplicados'}`)
  return partes.join(' · ')
}

/**
 * What the home does once `asignarYEscanearAction` answers for a code scanned with no barco chosen:
 * - `abrir`: the package is in the recepción of the barco (a duplicado, flagged, is in as well), which is opened.
 * - `quedarse`: the code is already in a recepción. It stays on the home with the red strip, and the recepción
 *   that was just opened for it (`sesionId`) is cleaned up if it is empty, so that it does not stay there with nothing.
 * - `fallo`: the action did not work. The dialog says why and keeps the code, so the operario can retry or cancel.
 *
 * `barcoNombre` is the barco that was chosen. The domain says `'esta recepción'` for a code that is already in the
 * recepción the scan went into (see `dondeEstaElCodigo` in lib/recepcion/recepciones.ts); that is clear on the screen
 * of a barco, and on the home it is not, so there it says which recepción it is.
 */
export type PasoTrasEscanearSinBarco =
  | { paso: 'abrir'; sesionId: string }
  | { paso: 'quedarse'; sesionId: string; respuesta: Respuesta }
  | { paso: 'fallo'; mensaje: string }

const DONDE_ESTA_RECEPCION = 'esta recepción'

export function pasoTrasEscanearSinBarco(
  respuesta: ResultadoAccion<{ sesionId: string; resultado: ResultadoEscaneo }>,
  barcoNombre: string,
): PasoTrasEscanearSinBarco {
  if (!respuesta.ok) return { paso: 'fallo', mensaje: respuesta.error }

  const { sesionId, resultado } = respuesta.valor
  if (resultado.tipo === 'agregado') return { paso: 'abrir', sesionId }

  const donde = resultado.donde === DONDE_ESTA_RECEPCION ? `la recepción de ${barcoNombre}` : resultado.donde
  return { paso: 'quedarse', sesionId, respuesta: respuestaDeEscaneo({ ...resultado, donde }) }
}
