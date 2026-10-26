import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireAdminFromCookies: vi.fn() }))
// Nothing here may reach QStash: what the action asks of the queue is all that is checked.
vi.mock('@/lib/queue/publish', () => ({ publishRefreshMaestros: vi.fn(), publishRefreshTrackings: vi.fn() }))

import { db } from '@/db/client'
import { auditLog, type Operario } from '@/db/schema'
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/guards'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { publishRefreshMaestros, publishRefreshTrackings } from '@/lib/queue/publish'
import { seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { refrescarDatosOdooAction } from './actions'

const SIN_ACCESO = 'No tenés acceso a esto.'
const SESION_VENCIDA = 'Tu sesión venció. Volvé a entrar.'
const GENERICO = 'Algo falló. Probá de nuevo.'

let admin: Operario

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  admin = await seedOperario(db, { nombre: 'Joaquín', rol: 'admin' })
  vi.mocked(requireAdminFromCookies).mockResolvedValue(admin)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('refrescarDatosOdooAction', () => {
  it('enqueues both refresh jobs and audits it', async () => {
    expect(await refrescarDatosOdooAction()).toEqual({ ok: true, valor: undefined })

    expect(publishRefreshMaestros).toHaveBeenCalledTimes(1)
    expect(publishRefreshTrackings).toHaveBeenCalledTimes(1)
    const filas = await db.select().from(auditLog)
    expect(filas).toHaveLength(1)
    // The admin who asked for it: the jobs write their own rows, with nobody, when they run.
    expect(filas[0]).toMatchObject({ operarioId: admin.id, accion: 'admin_refresco' })
  })

  it.each([
    ['an operario who is not an admin', new ForbiddenError('Se requiere rol admin'), SIN_ACCESO],
    ['an expired session', new UnauthorizedError('Sin sesión'), SESION_VENCIDA],
  ])('enqueues and audits nothing for %s', async (_quien, error, mensaje) => {
    vi.mocked(requireAdminFromCookies).mockRejectedValue(error)

    expect(await refrescarDatosOdooAction()).toEqual({ ok: false, error: mensaje })

    expect(publishRefreshMaestros).not.toHaveBeenCalled()
    expect(publishRefreshTrackings).not.toHaveBeenCalled()
    expect(await db.select().from(auditLog)).toEqual([])
  })

  it('answers with the failure, and does not audit a refresh that was not enqueued, when the queue fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(publishRefreshMaestros).mockRejectedValue(new Error('QStash is down'))

    expect(await refrescarDatosOdooAction()).toEqual({ ok: false, error: GENERICO })

    expect(publishRefreshTrackings).not.toHaveBeenCalled()
    expect(await db.select().from(auditLog)).toEqual([])
  })
})
