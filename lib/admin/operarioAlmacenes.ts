import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, operarioAlmacenes, type Almacen } from '../../db/schema'
import { ErrorParaOperario } from '../errores'

/**
 * The almacenes the operario can work in: the assigned ones that are still active (an almacén
 * Odoo no longer has stays assigned but cannot be worked in), by name. The order is part of the
 * contract: the first one is the default almacén when the device has not chosen another.
 */
export async function getAlmacenesForOperario(operarioId: string): Promise<Almacen[]> {
  const filas = await db.select({ almacen: almacenes })
    .from(operarioAlmacenes)
    .innerJoin(almacenes, eq(almacenes.id, operarioAlmacenes.almacenId))
    .where(and(eq(operarioAlmacenes.operarioId, operarioId), eq(almacenes.activo, true)))
    // lower() so that capitals do not sort apart under the C collation, as in searchBarcos;
    // the id last so that two almacenes with the same name always come in the same order.
    .orderBy(asc(sql`lower(${almacenes.nombre})`), asc(almacenes.id))
  return filas.map((fila) => fila.almacen)
}

/** Every almacén that is still active, by name, like `getAlmacenesForOperario`: what the admin can assign. */
export async function listAlmacenesActivos(): Promise<Almacen[]> {
  return db.select().from(almacenes)
    .where(eq(almacenes.activo, true))
    .orderBy(asc(sql`lower(${almacenes.nombre})`), asc(almacenes.id))
}

/**
 * Server-side authorization check for spec §6: an operario may only work in the
 * almacenes assigned to them. The UI merely hides the others. It looks at the
 * assignment only: an almacén that went inactive stays reachable for what is already open in it.
 */
export async function operarioHasAlmacen(operarioId: string, almacenId: number): Promise<boolean> {
  const row = await db.query.operarioAlmacenes.findFirst({
    where: (l, { and, eq: e }) => and(e(l.operarioId, operarioId), e(l.almacenId, almacenId)),
  })
  return row !== undefined && row !== null
}

/** An almacén as the admin form offers it for an operario. */
export type AlmacenParaAsignar = Almacen & {
  /** Whether the operario is linked to it now. */
  asignado: boolean
}

/**
 * What the admin form for an operario lists: every active almacén, and the inactive ones the operario is still
 * linked to, by name like `getAlmacenesForOperario`. The inactive ones are there because the link still gives access
 * (`operarioHasAlmacen` only looks at the link) and unticking it in the form is the only way to take it away. An
 * inactive almacén the operario is not linked to is not offered: there is nothing to take away, and nothing to work in.
 */
export async function listAlmacenesParaAsignar(operarioId: string): Promise<AlmacenParaAsignar[]> {
  const filas = await db.select({ almacen: almacenes, enlace: operarioAlmacenes.almacenId })
    .from(almacenes)
    .leftJoin(operarioAlmacenes, and(eq(operarioAlmacenes.almacenId, almacenes.id), eq(operarioAlmacenes.operarioId, operarioId)))
    .where(or(eq(almacenes.activo, true), isNotNull(operarioAlmacenes.almacenId)))
    // As in `getAlmacenesForOperario`: lower() so that capitals do not sort apart, the id last for a tie.
    .orderBy(asc(sql`lower(${almacenes.nombre})`), asc(almacenes.id))
  return filas.map(({ almacen, enlace }) => ({ ...almacen, asignado: enlace !== null }))
}

/**
 * Replaces ALL the operario's links with `almacenIds`: what the form had ticked is what the operario has afterwards, the
 * links to almacenes that went inactive included (the form lists them, so unticking one takes it away and leaving it
 * ticked keeps it).
 *
 * Every almacén submitted has to be active or one the operario is linked to already. Anything else (an inactive almacén
 * the operario never had, one that does not exist) is a stale or made-up form: the save is refused and nothing changes.
 */
export async function setAlmacenesForOperario(operarioId: string, almacenIds: number[]): Promise<void> {
  const ids = [...new Set(almacenIds)]
  const borrarTodos = db.delete(operarioAlmacenes).where(eq(operarioAlmacenes.operarioId, operarioId))
  if (ids.length === 0) {
    await borrarTodos
    return
  }

  const permitidos = await db.select({ id: almacenes.id })
    .from(almacenes)
    .leftJoin(operarioAlmacenes, and(eq(operarioAlmacenes.almacenId, almacenes.id), eq(operarioAlmacenes.operarioId, operarioId)))
    .where(and(inArray(almacenes.id, ids), or(eq(almacenes.activo, true), isNotNull(operarioAlmacenes.almacenId))))
  if (permitidos.length !== ids.length) {
    throw new ErrorParaOperario('Algunos de los almacenes elegidos no están disponibles. Recargá la pantalla y volvé a elegir.')
  }

  // Delete-then-insert must be atomic: a failure between the two would leave
  // the operario with no almacenes at all. `db.batch` is neon-http's atomic
  // primitive — the driver has no `transaction()` (it throws outright).
  await db.batch([
    borrarTodos,
    db.insert(operarioAlmacenes)
      .values(ids.map((almacenId) => ({ operarioId, almacenId })))
      .onConflictDoNothing(),
  ])
}
