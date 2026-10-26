import { and, asc, eq, exists, ne, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, operarioAlmacenes, operarios, type Operario } from '../../db/schema'
import { hashPassword } from '../auth/password'
import { ErrorParaOperario } from '../errores'

export async function listOperarios(): Promise<Operario[]> {
  return db.query.operarios.findMany()
}

/** What the admin list says next to the prefix of an almacén that went inactive. */
const MARCA_INACTIVO = ' (inactivo)'

/**
 * Every operario (the inactive ones and the admins too) with the prefixes of the almacenes they have, in alphabetical
 * order: what the admin list shows. The ones that went inactive are there too, marked ("MLC (inactivo)"): the link still
 * gives access, so the admin has to see it to take it away. By name, ignoring capitals (as `getAlmacenesForOperario`
 * does), and by id when two have the same name, so the list never moves between visits.
 */
export async function listOperariosConAlmacenes(): Promise<Array<Operario & { almacenes: string[] }>> {
  const [lista, enlaces] = await Promise.all([
    db.select().from(operarios).orderBy(asc(sql`lower(${operarios.nombre})`), asc(operarios.id)),
    db.select({ operarioId: operarioAlmacenes.operarioId, prefijo: almacenes.prefijo, activo: almacenes.activo })
      .from(operarioAlmacenes)
      .innerJoin(almacenes, eq(almacenes.id, operarioAlmacenes.almacenId))
      .orderBy(asc(almacenes.prefijo)),
  ])

  const prefijosDe = new Map<string, string[]>()
  for (const { operarioId, prefijo, activo } of enlaces) {
    prefijosDe.set(operarioId, [...(prefijosDe.get(operarioId) ?? []), activo ? prefijo : `${prefijo}${MARCA_INACTIVO}`])
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

/**
 * Activates or deactivates an operario. An id that names nobody is told in words (the update would do nothing and
 * the admin would be told it worked), and so is the one thing that must never happen: deactivating the last active admin,
 * which would leave nobody who can get into the admin screens to activate anyone again.
 *
 * For an active admin that is being deactivated, the check that another active admin is left and the update are one
 * statement, and the update is the one that is conditional: nothing happens between looking and writing.
 */
export async function setOperarioActivo(id: string, activo: boolean): Promise<void> {
  const operario = await db.query.operarios.findFirst({ columns: { rol: true, activo: true }, where: eq(operarios.id, id) })
  if (!operario) throw new ErrorParaOperario('Ese operario no existe.')

  if (activo || operario.rol !== 'admin' || !operario.activo) {
    await db.update(operarios).set({ activo }).where(eq(operarios.id, id))
    return
  }

  const otroAdminActivo = db.select({ uno: sql`1` }).from(operarios)
    .where(and(eq(operarios.rol, 'admin'), eq(operarios.activo, true), ne(operarios.id, id)))
  const desactivados = await db.update(operarios)
    .set({ activo: false })
    .where(and(eq(operarios.id, id), exists(otroAdminActivo)))
    .returning({ id: operarios.id })
  if (desactivados.length === 0) throw new ErrorParaOperario('Tiene que quedar al menos un admin activo.')
}
