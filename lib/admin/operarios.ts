import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, operarioAlmacenes, operarios, type Operario } from '../../db/schema'
import { hashPassword } from '../auth/password'
import { ErrorParaOperario } from '../errores'

export async function listOperarios(): Promise<Operario[]> {
  return db.query.operarios.findMany()
}

/**
 * Every operario (the inactive ones and the admins too) with the prefixes of the almacenes they have that
 * are still active, in alphabetical order: what the admin list shows. By name, ignoring capitals (as
 * `getAlmacenesForOperario` does), and by id when two have the same name, so the list never moves between visits.
 */
export async function listOperariosConAlmacenes(): Promise<Array<Operario & { almacenes: string[] }>> {
  const [lista, enlaces] = await Promise.all([
    db.select().from(operarios).orderBy(asc(sql`lower(${operarios.nombre})`), asc(operarios.id)),
    db.select({ operarioId: operarioAlmacenes.operarioId, prefijo: almacenes.prefijo })
      .from(operarioAlmacenes)
      .innerJoin(almacenes, eq(almacenes.id, operarioAlmacenes.almacenId))
      .where(eq(almacenes.activo, true))
      .orderBy(asc(almacenes.prefijo)),
  ])

  const prefijosDe = new Map<string, string[]>()
  for (const { operarioId, prefijo } of enlaces) {
    prefijosDe.set(operarioId, [...(prefijosDe.get(operarioId) ?? []), prefijo])
  }
  return lista.map((operario) => ({ ...operario, almacenes: prefijosDe.get(operario.id) ?? [] }))
}

export async function createOperario(input: {
  nombre: string
  login: string
  password: string
  rol: 'operario' | 'admin'
}): Promise<Operario> {
  // Said before the insert: the unique index would only answer with a database error, which the admin cannot read.
  const existente = await db.query.operarios.findFirst({
    columns: { id: true },
    where: eq(operarios.login, input.login),
  })
  if (existente) throw new ErrorParaOperario(`Ya hay un operario con el usuario "${input.login}".`)

  const passwordHash = await hashPassword(input.password)
  const [row] = await db.insert(operarios).values({
    nombre: input.nombre,
    login: input.login,
    passwordHash,
    rol: input.rol,
  }).returning()
  return row
}

export async function setOperarioActivo(id: string, activo: boolean): Promise<void> {
  await db.update(operarios).set({ activo }).where(eq(operarios.id, id))
}
