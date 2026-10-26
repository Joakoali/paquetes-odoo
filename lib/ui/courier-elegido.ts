// Types only: lib/recepcion/couriers.ts reaches the database, which must not get into the client.
import type { CourierOpcion } from '@/lib/recepcion/couriers'

/** Where the device remembers the courier used last. Per device, not per recepción: one courier brings parcels for many barcos. */
export const CLAVE_ULTIMO_COURIER = 'paqueteria:ultimoCourier'

type Almacenamiento = Pick<Storage, 'getItem' | 'setItem'>

/**
 * The storage of the browser, or null where there is none. Not even asking for it is safe: with blocked site data
 * (or in a private window of some browsers) reading `localStorage` throws.
 */
function almacenamientoDelNavegador(): Almacenamiento | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** The id of the courier used last on this device, or null when there is none or it cannot be read. Never throws. */
export function leerUltimoCourier(almacen: Almacenamiento | null = almacenamientoDelNavegador()): number | null {
  try {
    const guardado = almacen?.getItem(CLAVE_ULTIMO_COURIER) ?? null
    return guardado !== null && /^\d+$/.test(guardado) ? Number(guardado) : null
  } catch {
    return null
  }
}

/** Remembers the courier on this device. If the browser will not keep it, it is only not remembered. Never throws. */
export function guardarUltimoCourier(
  courierId: number,
  almacen: Almacenamiento | null = almacenamientoDelNavegador(),
): void {
  try {
    almacen?.setItem(CLAVE_ULTIMO_COURIER, String(courierId))
  } catch {
    // Nothing to do: the next recepción starts with the first courier instead.
  }
}

/**
 * The courier marked when the screen opens: the one used last on this device if it is still one of the couriers
 * (it may be one that is not among the frequent ones, chosen from "Otro courier…"), and otherwise the first
 * frequent one. Nobody when there are no couriers.
 */
export function courierInicial(
  frecuentes: CourierOpcion[],
  todos: CourierOpcion[],
  ultimoId: number | null,
): CourierOpcion | null {
  const ultimo = ultimoId === null ? undefined : todos.find((courier) => courier.id === ultimoId)
  return ultimo ?? frecuentes[0] ?? null
}

/** Without case and without accents, to compare what was typed with a name ("angel" finds "Ángel Express"). */
const sinAcentos = (texto: string) => texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** The couriers whose name has what the operario typed in it, in the order they came. All of them if he typed nothing. */
export function filtrarCouriers(couriers: CourierOpcion[], filtro: string): CourierOpcion[] {
  const buscado = sinAcentos(filtro.trim())
  if (buscado === '') return couriers
  return couriers.filter((courier) => sinAcentos(courier.nombre).includes(buscado))
}
