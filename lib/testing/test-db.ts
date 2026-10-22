import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as schema from '@/db/schema'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../db/migrations', import.meta.url))

/**
 * In-memory Postgres (PGlite) standing in for the app's neon-http `db`, plus the
 * `batch` that only neon-http has.
 */
export type TestDb = PgliteDatabase<typeof schema> & {
  $client: PGlite
  /**
   * Stand-in for neon-http's `db.batch([...])`: awaits each query in order and
   * resolves with their results in the same order. Unlike neon's it is NOT
   * atomic — queries that already ran are not rolled back if a later one fails.
   */
  batch<T extends PromiseLike<unknown>[]>(queries: [...T]): Promise<{ [K in keyof T]: Awaited<T[K]> }>
}

async function batch<T extends PromiseLike<unknown>[]>(queries: [...T]): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const results: unknown[] = []
  for (const query of queries) results.push(await query)
  return results as { [K in keyof T]: Awaited<T[K]> }
}

/**
 * A fresh in-memory database with every migration in `db/migrations` applied.
 * Typical use in a test that touches the database:
 *
 *   vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
 *   import { db } from '@/db/client'
 *   beforeEach(() => resetTestDb(db as unknown as TestDb))
 */
export async function createTestDb(): Promise<TestDb> {
  const db = drizzle(new PGlite(), { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  return Object.assign(db, { batch })
}

/**
 * Empties every table of the schema and restarts the identity sequences.
 * Refuses anything that is not the in-memory database: vitest.setup.ts loads the
 * real .env, so a test that forgot to mock '@/db/client' would otherwise
 * TRUNCATE the real one.
 */
export async function resetTestDb(db: TestDb): Promise<void> {
  if (!(db.$client instanceof PGlite)) {
    throw new Error('resetTestDb only works on the in-memory PGlite database from createTestDb()')
  }
  const tables = Object.values<unknown>(schema).filter((value): value is PgTable => is(value, PgTable))
  await db.execute(sql`TRUNCATE TABLE ${sql.join(tables, sql`, `)} RESTART IDENTITY CASCADE`)
}
