import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, couriers } from '../../db/schema'

export async function setAlmacenOdooPickingTypeId(almacenId: number, odooInTypeId: number): Promise<void> {
  await db.update(almacenes).set({ odooInTypeId }).where(eq(almacenes.id, almacenId))
}

export async function setCourierOdooProductId(courierId: number, odooProductId: number): Promise<void> {
  await db.update(couriers).set({ odooProductId }).where(eq(couriers.id, courierId))
}
