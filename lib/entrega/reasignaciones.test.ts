import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
// Nothing here reaches QStash: a test looks at what registrarReasignacion hands to publishing and auditing.
vi.mock('@/lib/queue/publish', () => ({ publishSync: vi.fn() }))
vi.mock('@/lib/audit', () => ({ registrarAuditoria: vi.fn() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { sesionesEscaneo, type Almacen, type Operario } from '@/db/schema'
import { registrarAuditoria } from '@/lib/audit'
import { publishSync } from '@/lib/queue/publish'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { registrarReasignacion, type NuevaReasignacion } from './reasignaciones'

let veronika: Operario
let mb92: Almacen

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  veronika = await seedOperario(db, { nombre: 'Veronika' })
  mb92 = await seedAlmacen(db)
})

/** Two packages of MAYANQUEEN (673) that go to ARCTIC (674), as the action hands them over. */
function nuevaReasignacion(datos: Partial<NuevaReasignacion> = {}): NuevaReasignacion {
  return {
    id: crypto.randomUUID(),
    operarioId: veronika.id,
    almacenId: mb92.id,
    barcoOdooId: 673,
    barcoDestinoOdooId: 674,
    pickingIds: [700, 701],
    moveLineIds: [11, 21],
    paquetes: [
      { trackingNumber: 'QA-DHL-001', courierNombre: 'DHL', pickingRef: 'MB92/OUT/00700' },
      { trackingNumber: null, courierNombre: 'UPS', pickingRef: 'MB92/OUT/00701' },
    ],
    ...datos,
  }
}

async function filaSesion(id: string) {
  const [fila] = await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, id))
  return fila
}

describe('registrarReasignacion', () => {
  it('saves it waiting for its sync, with both barcos and the lines and packages in the same order, and queues it', async () => {
    const entrada = nuevaReasignacion()

    await registrarReasignacion(entrada)

    const fila = await filaSesion(entrada.id)
    expect(fila).toMatchObject({
      tipo: 'reasignacion',
      estado: 'confirmada_pendiente_sync',
      operarioId: veronika.id,
      almacenId: mb92.id,
      barcoOdooId: 673,
      barcoDestinoOdooId: 674,
      odooPickingIds: [700, 701],
      odooMoveLineIds: [11, 21],
      paquetesDeOdoo: entrada.paquetes,
      receptorNombre: null,
      firmaData: null,
    })
    expect(fila.confirmedAt).toBeInstanceOf(Date)
    expect(publishSync).toHaveBeenCalledWith({ sesionId: entrada.id })
    expect(registrarAuditoria).toHaveBeenCalledWith({
      operarioId: veronika.id,
      accion: 'reasignacion_confirmada',
      detalle: { sesionId: entrada.id, almacenId: mb92.id, barcoOdooId: 673, barcoDestinoOdooId: 674, paquetes: 2 },
    })
  })

  it('is idempotent by id: a retry saves and audits nothing again, and queues it again only while it waits', async () => {
    const entrada = nuevaReasignacion()

    await registrarReasignacion(entrada)
    await registrarReasignacion({ ...entrada, moveLineIds: [], pickingIds: [], paquetes: [] })

    expect(await db.select().from(sesionesEscaneo)).toHaveLength(1)
    expect((await filaSesion(entrada.id)).odooMoveLineIds).toEqual([11, 21])
    expect(publishSync).toHaveBeenCalledTimes(2)
    expect(registrarAuditoria).toHaveBeenCalledTimes(1)

    await db.update(sesionesEscaneo).set({ estado: 'sincronizada' }).where(eq(sesionesEscaneo.id, entrada.id))
    await registrarReasignacion(entrada)
    expect(publishSync).toHaveBeenCalledTimes(2)
  })

  it('leaves alone an id that belongs to an entrega: nothing is saved or queued', async () => {
    const [entrega] = await db.insert(sesionesEscaneo).values({
      operarioId: veronika.id, almacenId: mb92.id, barcoOdooId: 673, tipo: 'entrega', estado: 'confirmada_pendiente_sync', confirmedAt: new Date(),
    }).returning()

    await registrarReasignacion(nuevaReasignacion({ id: entrega.id }))

    expect(publishSync).not.toHaveBeenCalled()
    expect(registrarAuditoria).not.toHaveBeenCalled()
    expect(await filaSesion(entrega.id)).toMatchObject({ tipo: 'entrega', barcoDestinoOdooId: null })
  })

  it('keeps it saved when queuing fails, for a retry with the same id to queue it', async () => {
    vi.mocked(publishSync).mockRejectedValueOnce(new Error('QStash no responde'))
    const entrada = nuevaReasignacion()

    await expect(registrarReasignacion(entrada)).rejects.toThrow('QStash no responde')
    expect(await filaSesion(entrada.id)).toMatchObject({ estado: 'confirmada_pendiente_sync' })

    await registrarReasignacion(entrada)
    expect(publishSync).toHaveBeenCalledTimes(2)
    expect(registrarAuditoria).toHaveBeenCalledTimes(1)
  })
})
