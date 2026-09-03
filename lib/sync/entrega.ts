import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { sesionesEscaneo } from '../../db/schema'
import { callKw } from '../odoo/client'
import { validatePicking } from '../odoo/pickings'

/**
 * THE single place entrega data is pushed to Odoo. Called by the QStash
 * single-consumer worker, one session at a time. Idempotent: a picking that
 * is already in state `done` is skipped, and a QStash re-delivery of an
 * already-synced session is a no-op.
 */
export async function syncEntregaSession(sesionId: string): Promise<void> {
  const sesion = await db.query.sesionesEscaneo.findFirst({ where: eq(sesionesEscaneo.id, sesionId) })
  if (!sesion) throw new Error(`Sesión ${sesionId} no encontrada`)

  // QStash may re-deliver a job whose previous run already fully succeeded.
  if (sesion.estado === 'sincronizada') return

  if (!sesion.odooPickingIds || !sesion.firmaData) {
    throw new Error(`Sesión ${sesionId} no tiene picking ids o firma`)
  }

  for (const pickingId of sesion.odooPickingIds) {
    const [current] = await callKw<Array<{ id: number; state: string }>>(
      'stock.picking', 'read', [[pickingId]], { fields: ['state'] },
    )
    if (current.state === 'done') continue

    await callKw('stock.picking', 'write', [[pickingId], {
      signature: sesion.firmaData,
      is_signed: true,
    }])
    await validatePicking(pickingId)
    await callKw('stock.picking', 'message_post', [[pickingId]], {
      body: `Entrega confirmada vía Webapp Paquetería por operario ${sesion.operarioId}`,
    })
  }

  await db.update(sesionesEscaneo).set({
    estado: 'sincronizada',
    syncedAt: new Date(),
  }).where(eq(sesionesEscaneo.id, sesionId))
}
