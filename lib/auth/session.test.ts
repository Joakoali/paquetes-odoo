import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { operarios, sesionesAuth, type Operario } from '@/db/schema'
import { seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { createSession, destroySession, getSessionOperario } from './session'

const NO_EXISTE = '00000000-0000-4000-8000-000000000000'

let juan: Operario

beforeEach(async () => {
  await resetTestDb(db as unknown as TestDb)
  juan = await seedOperario(db, { nombre: 'Juan' })
})

describe('session', () => {
  it('creates a session that names its operario, and can be destroyed', async () => {
    const token = await createSession(juan.id)
    expect(await getSessionOperario(token)).toEqual(juan)

    await destroySession(token)

    expect(await getSessionOperario(token)).toBeNull()
  })
})

describe('getSessionOperario', () => {
  it('answers null for a session that has expired', async () => {
    const [vencida] = await db.insert(sesionesAuth)
      .values({ operarioId: juan.id, expiresAt: new Date(Date.now() - 1000) })
      .returning()

    expect(await getSessionOperario(vencida.id)).toBeNull()
  })

  it('answers null for the session of an operario who was deactivated since', async () => {
    const token = await createSession(juan.id)
    await db.update(operarios).set({ activo: false }).where(eq(operarios.id, juan.id))

    expect(await getSessionOperario(token)).toBeNull()
  })

  it('answers null for a token that names no session', async () => {
    expect(await getSessionOperario(NO_EXISTE)).toBeNull()
  })

  it('answers the operario of the session, not another one', async () => {
    const ana = await seedOperario(db, { nombre: 'Ana' })
    await createSession(juan.id)

    expect(await getSessionOperario(await createSession(ana.id))).toEqual(ana)
  })
})
