// lib/sync/pendientes.ts
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { sesionesEscaneo, type SesionEscaneo } from '../../db/schema'
import { publishSync } from '../queue/publish'

export async function listSessionsInError(): Promise<SesionEscaneo[]> {
  return db.query.sesionesEscaneo.findMany({ where: eq(sesionesEscaneo.estado, 'error') })
}

export async function retrySession(sesionId: string): Promise<void> {
  await publishSync({ sesionId })
}
