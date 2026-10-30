import type { PaqueteDeOdoo } from '../../db/schema'
import { guardarYEncolar } from './entregas'

/** A reasignación the operario confirmed: the packages of a barco that go to another, in the almacén they are in. */
export interface NuevaReasignacion {
  /** Made up by the phone before its first try: what makes a retry harmless. */
  id: string
  operarioId: string
  almacenId: number
  /** The barco the packages are on now: the one whose delivery screen they were chosen on. */
  barcoOdooId: number
  barcoDestinoOdooId: number
  /** The deliveries the lines are on, each once. */
  pickingIds: number[]
  moveLineIds: number[]
  /** What each line is (package, courier, delivery), in the order of `moveLineIds`. */
  paquetes: PaqueteDeOdoo[]
}

/**
 * Registers a reasignación and queues it, once per `id` (see `guardarYEncolar`): the worker is the only one that moves
 * the packages in Odoo. The lines and their packages are kept together and in the same order, which is how the worker
 * finds a package by its number when Odoo made its line again under another id; they are also what Pendientes and the
 * search of a package say of it.
 */
export async function registrarReasignacion(entrada: NuevaReasignacion): Promise<void> {
  const { id, operarioId, almacenId, barcoOdooId, barcoDestinoOdooId, moveLineIds } = entrada

  await guardarYEncolar({
    sesion: {
      id,
      operarioId,
      almacenId,
      barcoOdooId,
      barcoDestinoOdooId,
      tipo: 'reasignacion',
      odooPickingIds: entrada.pickingIds,
      odooMoveLineIds: moveLineIds,
      paquetesDeOdoo: entrada.paquetes,
    },
    auditoria: {
      accion: 'reasignacion_confirmada',
      detalle: { sesionId: id, almacenId, barcoOdooId, barcoDestinoOdooId, paquetes: moveLineIds.length },
    },
  })
}
