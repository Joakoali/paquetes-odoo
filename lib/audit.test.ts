import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))

import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { seedOperario } from '@/lib/testing/seed'
import { registrarAuditoria } from './audit'

beforeEach(async () => {
  vi.restoreAllMocks()
  await resetTestDb(db as unknown as TestDb)
})

describe('registrarAuditoria', () => {
  it('writes who did what, with the detail as JSON', async () => {
    const operario = await seedOperario(db)

    await registrarAuditoria({
      operarioId: operario.id,
      accion: 'entrega_confirmada',
      detalle: { sesionId: 's1', paquetes: 3, barco: { odooId: 673, nombre: 'MAYANQUEEN' } },
    })

    const filas = await db.select().from(auditLog)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      operarioId: operario.id,
      accion: 'entrega_confirmada',
      detalle: { sesionId: 's1', paquetes: 3, barco: { odooId: 673, nombre: 'MAYANQUEEN' } },
    })
    expect(filas[0].createdAt).toBeInstanceOf(Date)
  })

  it('records an action nobody did, with no operario and no detail', async () => {
    await registrarAuditoria({ operarioId: null, accion: 'admin_refresco' })

    const [fila] = await db.select().from(auditLog)
    expect(fila).toMatchObject({ operarioId: null, accion: 'admin_refresco', detalle: null })
  })

  it('never throws: when the insert fails it logs with console.error and the caller goes on', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    // An operario that does not exist breaks the audit_log foreign key.
    await expect(
      registrarAuditoria({ operarioId: '00000000-0000-4000-8000-000000000000', accion: 'sync_ok' }),
    ).resolves.toBeUndefined()

    expect(consoleError).toHaveBeenCalledOnce()
    expect(await db.select().from(auditLog)).toHaveLength(0)
  })
})
