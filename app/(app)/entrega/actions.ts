'use server'

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { almacenes, sesionesEscaneo } from '@/db/schema'
import { ForbiddenError } from '@/lib/auth/guards'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import { getPendingOutgoing, type PendingDelivery } from '@/lib/odoo/pickings'
import { publishSync } from '@/lib/queue/publish'

async function requireAlmacenAccess(almacenId: number): Promise<string> {
  const operario = await requireOperarioFromCookies()
  if (!(await operarioHasAlmacen(operario.id, almacenId))) {
    throw new ForbiddenError(`Operario sin acceso al almacén ${almacenId}`)
  }
  return operario.id
}

export async function loadPendingDeliveries(almacenId: number, barcoOdooId: number): Promise<PendingDelivery[]> {
  await requireAlmacenAccess(almacenId)
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
  const operarioId = await requireAlmacenAccess(almacenId)

  // The canvas hands us a `data:image/png;base64,...` URI; Odoo's binary
  // `stock.picking.signature` field wants bare base64. Strip it once, here at
  // the boundary, so nothing downstream has to know about the prefix.
  const firma = firmaDataBase64.includes(',') ? firmaDataBase64.split(',')[1] : firmaDataBase64

  const [row] = await db.insert(sesionesEscaneo).values({
    operarioId,
    almacenId,
    barcoOdooId,
    tipo: 'entrega',
    estado: 'confirmada_pendiente_sync',
    odooPickingIds: selectedPickingIds,
    firmaData: firma,
    confirmedAt: new Date(),
  }).returning()

  await publishSync({ sesionId: row.id })
  return row.id
}
