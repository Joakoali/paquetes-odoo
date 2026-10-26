// Types only: lib/recepcion/recepciones.ts reaches the database, which must not get into the client.
import type { PaqueteEscaneado, ResultadoEscaneo } from '@/lib/recepcion/recepciones'

/**
 * A row of the list of packages of a recepción. A scan makes its row at the moment the gun presses Enter, as
 * `verificando`, and the answer of the server (which comes later, and in order) settles it. So the operario sees
 * every code he scanned, in the order he scanned it, whatever the server takes to answer.
 */
export interface FilaEscaneo {
  /** Identifies the row on the screen: the key of the scan, or the id of the package for the ones that were already there. */
  clave: string
  trackingNumber: string
  courierId: number
  courierNombre: string
  /**
   * `verificando`: sent, no answer yet. `ok`: it is in the recepción and will be sent to Odoo. `duplicado`: it is in
   * the recepción, flagged, because Odoo already has it; it is not sent. `error`: the scan did not get through.
   */
  estado: 'verificando' | 'ok' | 'duplicado' | 'error'
  /** For a `duplicado`, the reference Odoo has it under; for an `error`, why. Null otherwise. */
  detalle: string | null
  /** The id of the package once the server has it: what ✕ deletes. Null while verifying and for an `error`. */
  itemId: string | null
}

export type AccionCola =
  | { tipo: 'escaneado'; clave: string; trackingNumber: string; courierId: number; courierNombre: string }
  | { tipo: 'resuelto'; clave: string; resultado: ResultadoEscaneo }
  | { tipo: 'fallido'; clave: string; mensaje: string }
  | { tipo: 'borrado'; itemId: string }

/**
 * The list after something happened to it. The newest row is on top, and a row never changes place once it is
 * in: an answer settles the row it belongs to (by `clave`), wherever that row is.
 *
 * `resuelto` with a `repetido` takes the provisional row out: that code is already in a recepción, so there is no
 * new package to show, and the screen says where it is. `fallido` keeps the row, as an `error`, so the operario
 * can see which code did not get through; scanning that code again replaces it.
 */
export function colaReducer(filas: FilaEscaneo[], accion: AccionCola): FilaEscaneo[] {
  switch (accion.tipo) {
    case 'escaneado': {
      const fila: FilaEscaneo = {
        clave: accion.clave,
        trackingNumber: accion.trackingNumber,
        courierId: accion.courierId,
        courierNombre: accion.courierNombre,
        estado: 'verificando',
        detalle: null,
        itemId: null,
      }
      // A code that failed is being scanned again: this attempt is the one to show, not the two of them.
      return [fila, ...filas.filter((otra) => !(otra.estado === 'error' && otra.trackingNumber === accion.trackingNumber))]
    }

    case 'resuelto': {
      const { resultado } = accion
      if (resultado.tipo === 'repetido') return filas.filter((fila) => fila.clave !== accion.clave)

      const { paquete } = resultado
      return filas.map((fila) => fila.clave !== accion.clave ? fila : {
        ...fila,
        // What the server stored, which is what the recepción has.
        trackingNumber: paquete.trackingNumber,
        courierId: paquete.courierId,
        courierNombre: paquete.courierNombre,
        estado: paquete.estado,
        detalle: paquete.duplicadoRef,
        itemId: paquete.id,
      })
    }

    case 'fallido':
      return filas.map((fila) => fila.clave !== accion.clave ? fila : { ...fila, estado: 'error', detalle: accion.mensaje })

    case 'borrado':
      return filas.filter((fila) => fila.itemId !== accion.itemId)
  }
}

/** The rows of a recepción that is opened: its packages, the newest first, as `getRecepcion` gives them. */
export function filasIniciales(paquetes: PaqueteEscaneado[]): FilaEscaneo[] {
  return paquetes.map((paquete) => ({
    clave: paquete.id,
    trackingNumber: paquete.trackingNumber,
    courierId: paquete.courierId,
    courierNombre: paquete.courierNombre,
    estado: paquete.estado,
    detalle: paquete.duplicadoRef,
    itemId: paquete.id,
  }))
}

/**
 * The code the gun typed, as the recepción takes it: without the blanks at both ends and in no other way changed.
 * Null when there is nothing in it: an Enter on an empty field is not a scan.
 */
export function normalizarCodigo(crudo: string): string | null {
  const codigo = crudo.trim()
  return codigo === '' ? null : codigo
}

export interface ConteoDeFilas {
  /** The valid packages: what "Enviar a Odoo" sends. */
  paraEnviar: number
  /** The ones Odoo already has: in the recepción, flagged, and not sent. */
  duplicados: number
  /** What the server has taken: the valid ones and the duplicados. */
  escaneados: number
  /** The scans that have not been answered yet. */
  verificando: number
  /** The scans that did not get through. */
  conError: number
  /** What the recepción holds or is about to hold, once the scans being verified are answered. */
  enRecepcion: number
}

export function contarFilas(filas: FilaEscaneo[]): ConteoDeFilas {
  const deEstado = (estado: FilaEscaneo['estado']) => filas.filter((fila) => fila.estado === estado).length
  const paraEnviar = deEstado('ok')
  const duplicados = deEstado('duplicado')
  const verificando = deEstado('verificando')
  return {
    paraEnviar,
    duplicados,
    escaneados: paraEnviar + duplicados,
    verificando,
    conError: deEstado('error'),
    enRecepcion: paraEnviar + duplicados + verificando,
  }
}

/** "1 paquete", "3 paquetes", "0 paquetes". */
export function textoDePaquetes(cantidad: number): string {
  return `${cantidad} ${cantidad === 1 ? 'paquete' : 'paquetes'}`
}

/**
 * What the list of packages is headed with: how many were scanned, the duplicados among them, and only if there are
 * any, the scans being checked and the ones that did not get through ("Paquetes · 4 escaneados · 1 duplicado").
 */
export function rotuloDeLaLista(conteo: ConteoDeFilas): string {
  const { escaneados, duplicados, verificando, conError } = conteo
  const partes = [`${escaneados} ${escaneados === 1 ? 'escaneado' : 'escaneados'}`]
  if (duplicados > 0) partes.push(`${duplicados} ${duplicados === 1 ? 'duplicado' : 'duplicados'}`)
  if (verificando > 0) partes.push(`${verificando} verificando`)
  if (conError > 0) partes.push(`${conError} con error`)
  return `Paquetes · ${partes.join(' · ')}`
}

let contador = 0

/**
 * The key of a scan. It is `crypto.randomUUID()`, which only exists where the page is a secure context (https, or
 * localhost): the tablet opening a dev server by its address on the network would have none, and the first scan
 * would then throw. So the fallback is a key that is also unique, only less random.
 */
export function claveNueva(): string {
  const generador = globalThis.crypto
  if (typeof generador?.randomUUID === 'function') return generador.randomUUID()
  contador += 1
  return `local-${Date.now().toString(36)}-${contador}-${Math.random().toString(36).slice(2, 8)}`
}
