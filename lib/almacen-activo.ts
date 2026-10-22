import { cookies } from 'next/headers'
import type { Almacen } from '../db/schema'
import { getAlmacenesForOperario } from './admin/operarioAlmacenes'
import { ErrorParaOperario } from './errores'

/**
 * Remembers, per device, the almacén the operario last chose to work in. Whatever it holds is
 * only a preference: it is checked against the operario's almacenes every time it is read.
 */
export const ALMACEN_COOKIE = 'paqueteria_almacen'

export interface AlmacenesDelOperario {
  /** The almacén being worked in; null when the operario has no active almacén assigned. */
  activo: Almacen | null
  /** Every almacén the operario can work in, in the order of `getAlmacenesForOperario`. */
  disponibles: Almacen[]
}

/** The id the cookie holds, or null when it does not hold one. Digits only: "1abc" is not 1. */
function idDeLaCookie(valor: string | undefined): number | null {
  return valor !== undefined && /^\d+$/.test(valor) ? Number(valor) : null
}

/**
 * The almacén the operario is working in: the one in the cookie if it is still one of theirs,
 * and otherwise the first they have. A device shared by operarios with different almacenes, or
 * an almacén that went inactive, cannot leave the screens pointing at one they cannot use.
 */
export async function getAlmacenActivo(operarioId: string): Promise<AlmacenesDelOperario> {
  const [disponibles, store] = await Promise.all([getAlmacenesForOperario(operarioId), cookies()])
  const elegido = idDeLaCookie(store.get(ALMACEN_COOKIE)?.value)
  const activo = disponibles.find((almacen) => almacen.id === elegido) ?? disponibles[0] ?? null
  return { activo, disponibles }
}

/** The active almacén, for what cannot be done without one. */
export async function requireAlmacenActivo(operarioId: string): Promise<Almacen> {
  const { activo } = await getAlmacenActivo(operarioId)
  if (!activo) throw new ErrorParaOperario('No tenés almacenes asignados. Avisá al admin.')
  return activo
}
