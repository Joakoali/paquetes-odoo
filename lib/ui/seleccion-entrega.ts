import { haceCuanto } from '@/lib/fechas'
// Type only: lib/odoo/pickings.ts reaches Odoo, which must not get into the client.
import type { LineaEntrega } from '@/lib/odoo/pickings'
import { textoDePaquetes } from './cola-escaneo'

/*
 * What the delivery screens decide apart from how they look: which packages are chosen and what that adds up to, the
 * texts that say it, the filter of the list of barcos, and when the crew's confirmation can be sent.
 */

/** The longest name of who receives that is accepted: the field of the form and the action that confirms share it. */
export const MAX_NOMBRE_RECEPTOR = 80

export interface ResumenSeleccion {
  /** Every line there is to deliver for the barco. */
  total: number
  /** The lines chosen. */
  elegidas: number
  /** The deliveries the chosen lines are on, each once, in the order of the lines: those are the ones that are touched. */
  pickingIds: number[]
  /** The chosen lines, in the order of the list. */
  moveLineIds: number[]
}

/**
 * What the choice adds up to. It goes by the lines that are on the list, not by the ids in `elegidas`: one left over
 * from a line that went away is not a package, and what is sent must be what is on the screen.
 */
export function resumenSeleccion(lineas: LineaEntrega[], elegidas: ReadonlySet<number>): ResumenSeleccion {
  const marcadas = lineas.filter((linea) => elegidas.has(linea.moveLineId))
  return {
    total: lineas.length,
    elegidas: marcadas.length,
    pickingIds: [...new Set(marcadas.map((linea) => linea.pickingId))],
    moveLineIds: marcadas.map((linea) => linea.moveLineId),
  }
}

/** The choice after touching a line: out if it was in, in if it was out. A new set, because React state is not mutated. */
export function alternarLinea(elegidas: ReadonlySet<number>, moveLineId: number): Set<number> {
  const siguiente = new Set(elegidas)
  if (!siguiente.delete(moveLineId)) siguiente.add(moveLineId)
  return siguiente
}

/** What heads the list of packages: "Se entregan 11 de 12". */
export function textoDeSeleccion({ elegidas, total }: Pick<ResumenSeleccion, 'elegidas' | 'total'>): string {
  return `Se entregan ${elegidas} de ${total}`
}

/** The button that goes to the signature: "Siguiente: firma · 11 paquetes". With none chosen there is no next step, and it says what is missing. */
export function textoDeSiguiente(elegidas: number): string {
  return elegidas === 0 ? 'Elegí al menos un paquete' : `Siguiente: firma · ${textoDePaquetes(elegidas)}`
}

/** What a barco of the list says when it has packages received and not sent to Odoo yet ("+3 sin enviar a Odoo"), or null when it has none. */
export function textoDeSinEnviar(cantidad: number): string | null {
  return cantidad > 0 ? `+${cantidad} sin enviar a Odoo` : null
}

/** The strip of the list of packages of a barco that has some received and not sent. */
export function textoDeAvisoSinEnviar(cantidad: number): string {
  return cantidad === 1
    ? 'Hay 1 paquete de este barco recibido pero sin enviar a Odoo'
    : `Hay ${cantidad} paquetes de este barco recibidos pero sin enviar a Odoo`
}

/** The strip of the list of packages of a barco some of whose packages are already in an entrega that is on its way to Odoo. */
export function textoDeEnviandose(cantidad: number): string {
  return `${textoDePaquetes(cantidad)} ${cantidad === 1 ? 'ya entregado' : 'ya entregados'}, enviándose a Odoo`
}

/**
 * What the list of packages says when there is nothing to choose: either Odoo has nothing, or what it has is on its way
 * (`enCamino`: the packages an entrega is handing over or a reasignación is moving to another barco).
 */
export function textoSinPaquetes(enCamino: number): string {
  return enCamino > 0 ? 'No quedan más paquetes para entregar.' : 'Odoo no tiene paquetes esperando entrega para este barco.'
}

/**
 * A line of the list: what stands for the package, and the courier apart from it. A line without lot has no package
 * number, so it says "sin número" after its courier, which then is not repeated.
 */
export function textoDeLinea(linea: Pick<LineaEntrega, 'trackingNumber' | 'courierNombre'>): { codigo: string; courier: string | null } {
  return linea.trackingNumber === null
    ? { codigo: `${linea.courierNombre} · sin número`, courier: null }
    : { codigo: linea.trackingNumber, courier: linea.courierNombre }
}

/**
 * What a barco of the list says about how long it has been waiting. `desde` is null for a barco that Odoo has no delivery
 * for yet: all its packages are received and not sent.
 */
export function textoDeEspera(desde: Date | null, ahora: Date): string {
  if (desde === null) return 'nada en Odoo todavía'
  const cuanto = haceCuanto(desde, ahora)
  // "desde recién" does not say anything.
  return cuanto === 'recién' ? 'llegó recién' : `desde ${cuanto}`
}

/** The text without accents and in lower case: what is compared, so that "aguila" finds "Águila". */
function paraComparar(texto: string): string {
  return texto.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/**
 * The barcos whose label contains what is in the field of the list, from the first letter (the list is short: it is the
 * barcos with something to deliver, and filtering it asks nothing of the server). The label is what the list shows
 * of each barco: its name, and its Odoo id when another barco has the same name, so that the id finds it too. The
 * blanks at the ends of what was typed are not part of it. The order is the one of the list.
 */
export function filtrarBarcos<T extends { barcoEtiqueta: string }>(barcos: T[], escrito: string): T[] {
  const buscado = paraComparar(escrito.trim())
  if (buscado === '') return barcos
  return barcos.filter((barco) => paraComparar(barco.barcoEtiqueta).includes(buscado))
}

/** Whether the crew's confirmation can be sent: who receives, their signature, and something to deliver. */
export function puedeConfirmar({ receptor, firma, elegidas }: { receptor: string; firma: string | null; elegidas: number }): boolean {
  return receptor.trim() !== '' && firma !== null && elegidas > 0
}
