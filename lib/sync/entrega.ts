import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { operarios, sesionesEscaneo } from '../../db/schema'
import { registrarAuditoria } from '../audit'
import { ConfiguracionError } from '../errores'
import { odooCall } from '../odoo/client'
import { validarEntrega } from '../odoo/pickings'

/** What the worker needs to know of a delivery to decide what is left to do on it. */
interface PickingLeido {
  state: string
  move_line_ids: number[]
  is_signed: boolean
}

/** The note left in the chatter of a delivery: who received, who handed over, how many, and how many stayed. */
function notaDeEntrega(entrada: {
  receptor: string
  operario: string
  paquetes: number
  quedanEnDeposito: number
}): string {
  const nota = `Entregado a ${entrada.receptor} vía Webapp Paquetería por ${entrada.operario}: ${entrada.paquetes} paquete(s)`
  return entrada.quedanEnDeposito > 0 ? `${nota}; ${entrada.quedanEnDeposito} quedan en depósito` : nota
}

/**
 * THE single place entrega data is pushed to Odoo. Called by the QStash single-consumer worker, one session
 * at a time. For each delivery involved it validates only the packages the crew was given (the rest stay in
 * a native backorder, "en depósito"), then signs it and writes the name of who received it.
 *
 * Idempotent: safe to retry after a partial failure, because each step first looks at what Odoo already has.
 * A picking that is `done` is not validated again, and one that is signed is not signed again, so a retry
 * after the validation goes straight to the signature. It only acts on an entrega that is
 * `confirmada_pendiente_sync`; for any other it returns without calling Odoo or changing anything.
 */
export async function syncEntregaSession(sesionId: string): Promise<void> {
  const sesion = await db.query.sesionesEscaneo.findFirst({ where: eq(sesionesEscaneo.id, sesionId) })
  if (!sesion) throw new Error(`Sesión ${sesionId} no encontrada`)

  // Only an entrega that was confirmed and is waiting for its sync is the worker's to touch. A message can still
  // arrive for any other one: QStash re-delivering a run that already finished (`sincronizada`), or a message from
  // before Pendientes' "Reintentar" put a failed entrega (`error`) back to `confirmada_pendiente_sync` and queued it
  // again. None of them may be synced, nor fail here: a failure would send a finished entrega to `error`.
  if (sesion.estado !== 'confirmada_pendiente_sync') return

  // Found out now, before anything is done in Odoo, so that a missing field (something an admin has to fix)
  // leaves no picking validated without its name.
  const recibidoPorField = process.env.ODOO_FIELD_RECIBIDO_POR
  if (!recibidoPorField) throw new ConfiguracionError('ODOO_FIELD_RECIBIDO_POR no está configurado')

  const { odooPickingIds, odooMoveLineIds, firmaData, receptorNombre } = sesion
  if (!odooPickingIds || !odooMoveLineIds || !firmaData || !receptorNombre) {
    throw new Error(`Sesión ${sesionId} no tiene picking ids, líneas elegidas, firma o receptor`)
  }

  // The chatter note names who handed the packages over: an id means nothing in Odoo.
  const [operario] = await db.select({ nombre: operarios.nombre }).from(operarios).where(eq(operarios.id, sesion.operarioId))
  if (!operario) throw new Error(`Operario ${sesion.operarioId} no encontrado`)

  const elegidasDeLaSesion = new Set(odooMoveLineIds)
  for (const pickingId of odooPickingIds) {
    const [picking] = await odooCall<PickingLeido[]>('stock.picking', 'read', {
      ids: [pickingId],
      fields: ['state', 'move_line_ids', 'is_signed'],
    })
    if (!picking) throw new Error(`picking ${pickingId} no existe en Odoo`)

    // The packages of this delivery that the crew was given. A delivery with none of them is not this entrega's to touch.
    const elegidas = picking.move_line_ids.filter((linea) => elegidasDeLaSesion.has(linea))
    if (elegidas.length === 0) continue

    let hizoAlgo = false
    let quedanEnDeposito = 0

    // A retry finds the picking `done` when an earlier attempt validated it and failed after that.
    if (picking.state !== 'done') {
      const validada = await validarEntrega({ pickingId, moveLineIdsElegidas: elegidas })
      quedanEnDeposito = validada.quedanEnDeposito
      hizoAlgo = true
    }

    // After validating and never before: the backorder Odoo makes of what stays in depósito copies what the
    // picking has, and must not get the name or the signature of a delivery it was not part of.
    // `is_signed` is computed by Odoo from `signature`, so only the signature is written.
    if (!picking.is_signed) {
      await odooCall('stock.picking', 'write', {
        ids: [pickingId],
        vals: { signature: firmaData, [recibidoPorField]: receptorNombre },
      })
      hizoAlgo = true
    }

    // A picking this run did nothing to (already done and signed) gets no note. A retry that only signs cannot say
    // how many packages stayed in depósito: only the run that validated knew.
    if (hizoAlgo) {
      await odooCall('stock.picking', 'message_post', {
        ids: [pickingId],
        body: notaDeEntrega({
          receptor: receptorNombre,
          operario: operario.nombre,
          paquetes: elegidas.length,
          quedanEnDeposito,
        }),
      })
    }
  }

  // A failure that an earlier attempt left behind (one QStash then retried) is over.
  await db.update(sesionesEscaneo)
    .set({
      estado: 'sincronizada',
      syncedAt: new Date(),
      ultimoError: null,
      ultimoErrorTipo: null,
    })
    .where(eq(sesionesEscaneo.id, sesionId))

  await registrarAuditoria({
    operarioId: null,
    accion: 'sync_ok',
    detalle: { sesionId, odooPickingIds },
  })
}
