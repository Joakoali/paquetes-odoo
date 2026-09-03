'use server'

import { eq } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { db } from '@/db/client'
import { almacenes, sesionesEscaneo } from '@/db/schema'
import { requireOperario } from '@/lib/auth/guards'
import { getPendingOutgoing, type PendingDelivery } from '@/lib/odoo/pickings'
import { publishSync } from '@/lib/queue/publish'

async function currentOperarioId(): Promise<string> {
  const store = await cookies()
  const operario = await requireOperario(store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value)
  return operario.id
}

export async function loadPendingDeliveries(almacenId: number, barcoOdooId: number): Promise<PendingDelivery[]> {
  const almacen = await db.query.almacenes.findFirst({ where: eq(almacenes.id, almacenId) })
  if (!almacen?.odooPickingTypeId) throw new Error(`Almacén ${almacenId} no tiene odoo_picking_type_id configurado`)
  return getPendingOutgoing(almacen.odooPickingTypeId, barcoOdooId)
}

export async function confirmEntregaSession(
  almacenId: number,
  barcoOdooId: number,
  selectedPickingIds: number[],
  firmaDataBase64: string,
): Promise<string> {
  const operarioId = await currentOperarioId()
  const [row] = await db.insert(sesionesEscaneo).values({
    operarioId,
    almacenId,
    barcoOdooId,
    tipo: 'entrega',
    estado: 'confirmada_pendiente_sync',
    odooPickingIds: selectedPickingIds,
    firmaData: firmaDataBase64,
    confirmedAt: new Date(),
  }).returning()

  await publishSync({ sesionId: row.id })
  return row.id
}
