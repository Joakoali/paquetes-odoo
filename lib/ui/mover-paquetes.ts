// Type only: lib/entrega/lineas.ts is for the server.
import type { Moviendose } from '@/lib/entrega/lineas'
import { textoDePaquetes } from './cola-escaneo'

/*
 * What the screen that moves packages of a barco to another one says, apart from how it looks, and what the server
 * answers when the barco chosen will not do.
 */

/** The barco chosen to move the packages to is the one they are on. */
export const MISMO_BARCO = 'Los paquetes ya son de ese barco. Elegí otro.'

/** The barco chosen to move the packages to is not one the search of barcos offers. */
export const BARCO_DESTINO_DESCONOCIDO = 'Ese barco no está en la lista de barcos. Elegí otro o pedí al admin que refresque los datos de Odoo.'

/** What heads the list of packages while choosing which go to another barco: "Se mueven 2 de 12". */
export function textoDeSeleccionAMover({ elegidas, total }: { elegidas: number; total: number }): string {
  return `Se mueven ${elegidas} de ${total}`
}

/** The button that goes on to choose the barco: "Elegir el barco · 2 paquetes". With none chosen, what is missing. */
export function textoDeElegirBarco(elegidas: number): string {
  return elegidas === 0 ? 'Elegí al menos un paquete' : `Elegir el barco · ${textoDePaquetes(elegidas)}`
}

/** What the confirmation asks: "Mover 2 paquetes de MAYANQUEEN a ARCTIC". */
export function textoDeConfirmacion({ paquetes, origen, destino }: { paquetes: number; origen: string; destino: string }): string {
  return `Mover ${textoDePaquetes(paquetes)} de ${origen} a ${destino}`
}

/** The strip of a barco some of whose packages a reasignación on its way to Odoo is taking: "2 paquetes pasándose a ARCTIC". */
export function textoDeMoviendose({ barcoNombre, paquetes }: Moviendose): string {
  return `${textoDePaquetes(paquetes)} pasándose a ${barcoNombre}`
}
