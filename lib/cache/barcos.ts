import { ilike, sql } from 'drizzle-orm'
import { callKw } from '../odoo/client'
import { db } from '../../db/client'
import { barcosCache } from '../../db/schema'

interface ProjectRead {
  id: number
  name: string
}

export async function refreshBarcosCache(): Promise<void> {
  const projects = await callKw<ProjectRead[]>('project.project', 'search_read', [[]], { fields: ['name'] })
  if (projects.length === 0) return

  await db.insert(barcosCache)
    .values(projects.map((p) => ({ odooId: p.id, nombre: p.name })))
    .onConflictDoUpdate({
      target: barcosCache.odooId,
      // `excluded.nombre` is the incoming value; `barcosCache.nombre` would
      // write the column to itself, so a renamed barco never updated.
      set: { nombre: sql`excluded.nombre`, updatedAt: new Date() },
    })
}

export async function searchBarcos(query: string): Promise<Array<{ odooId: number; nombre: string }>> {
  return db.select({ odooId: barcosCache.odooId, nombre: barcosCache.nombre })
    .from(barcosCache)
    .where(ilike(barcosCache.nombre, `%${query}%`))
}
