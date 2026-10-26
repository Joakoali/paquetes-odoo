import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
// The Odoo read is mocked whole: these tests never reach Odoo. Publishing and auditing are mocked: nothing
// here reaches QStash, and a test looks at what registrarEntrega (and recepciones.ts) hand them.
vi.mock('@/lib/odoo/pickings', () => ({ getBarcosConEntregaPendiente: vi.fn() }))
vi.mock('@/lib/queue/publish', () => ({ publishSync: vi.fn() }))
vi.mock('@/lib/audit', () => ({ registrarAuditoria: vi.fn() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { sesionesEscaneo, type Almacen, type Courier, type Operario } from '@/db/schema'
import { registrarAuditoria } from '@/lib/audit'
import { ConfiguracionError } from '@/lib/errores'
import { getBarcosConEntregaPendiente, type BarcoConEntrega } from '@/lib/odoo/pickings'
import { publishSync } from '@/lib/queue/publish'
import { abrirRecepcion, escanearPaquete } from '@/lib/recepcion/recepciones'
import { seedAlmacen, seedBarco, seedCourier, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { entregaGuardada, listarBarcosParaEntregar, listarEntregadasHoy, registrarEntrega } from './entregas'

let veronika: Operario
let mb92: Almacen
let dhl: Courier

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  veronika = await seedOperario(db, { nombre: 'Veronika' })
  mb92 = await seedAlmacen(db) // reception type 1, delivery type 2
  dhl = await seedCourier(db)
  await seedBarco(db) // 673 MAYANQUEEN
  await seedBarco(db, { odooId: 674, nombre: 'MAYANQUEENIV' })
})

/** What Odoo answers when asked which barcos have a delivery waiting. */
function odooTiene(...barcos: BarcoConEntrega[]) {
  vi.mocked(getBarcosConEntregaPendiente).mockResolvedValue(barcos)
}

const mayanqueen: BarcoConEntrega = { barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', paquetes: 3, desde: new Date('2026-10-14T08:00:00Z') }

let paquetesEscaneados = 0

/** Packages received for the barco and not sent to Odoo: scanned into its open recepción, which is opened if there is none. */
async function recibirSinEnviar(almacen: Almacen, barcoOdooId: number, cantidad: number) {
  const sesionId = await abrirRecepcion({ almacenId: almacen.id, barcoOdooId, operarioId: veronika.id })
  for (let i = 0; i < cantidad; i++) {
    paquetesEscaneados += 1
    await escanearPaquete({ sesionId, courierId: dhl.id, trackingNumber: `TRK${paquetesEscaneados}`, operarioId: veronika.id })
  }
}

describe('listarBarcosParaEntregar', () => {
  it('lists the barcos Odoo has a delivery waiting for, with nothing unsent', async () => {
    odooTiene(mayanqueen)

    expect(await listarBarcosParaEntregar(mb92)).toEqual([{ ...mayanqueen, sinEnviar: 0 }])
  })

  it('asks Odoo for the delivery type of the almacén, not the reception one', async () => {
    odooTiene()

    await listarBarcosParaEntregar(mb92)

    expect(getBarcosConEntregaPendiente).toHaveBeenCalledTimes(1)
    expect(getBarcosConEntregaPendiente).toHaveBeenCalledWith(2)
  })

  it('marks sinEnviar from open recepciones', async () => {
    odooTiene(mayanqueen)
    await recibirSinEnviar(mb92, 673, 2)

    expect(await listarBarcosParaEntregar(mb92)).toEqual([{ ...mayanqueen, sinEnviar: 2 }])
  })

  it('adds barcos that only have unsent packages, with 0 packages, no date and the name from the cache', async () => {
    odooTiene(mayanqueen)
    await recibirSinEnviar(mb92, 674, 3)

    expect(await listarBarcosParaEntregar(mb92)).toEqual([
      { ...mayanqueen, sinEnviar: 0 },
      { barcoOdooId: 674, barcoNombre: 'MAYANQUEENIV', paquetes: 0, desde: null, sinEnviar: 3 },
    ])
  })

  it('lists only the unsent barcos when Odoo has no delivery waiting', async () => {
    odooTiene()
    await recibirSinEnviar(mb92, 673, 1)

    expect(await listarBarcosParaEntregar(mb92)).toEqual([
      { barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', paquetes: 0, desde: null, sinEnviar: 1 },
    ])
  })

  it('names a barco that only has unsent packages and is not in the cache by its id', async () => {
    odooTiene()
    await recibirSinEnviar(mb92, 999, 1)

    expect(await listarBarcosParaEntregar(mb92)).toEqual([
      { barcoOdooId: 999, barcoNombre: 'Barco #999', paquetes: 0, desde: null, sinEnviar: 1 },
    ])
  })

  it('ignores what is unsent in another almacén', async () => {
    const tgn = await seedAlmacen(db, { prefijo: 'TGN', nombre: 'Port Tarraco (TGN)', odooWarehouseId: 5, odooInTypeId: 21, odooOutTypeId: 22 })
    odooTiene(mayanqueen)
    await recibirSinEnviar(tgn, 673, 4)
    await recibirSinEnviar(tgn, 674, 1)

    expect(await listarBarcosParaEntregar(mb92)).toEqual([{ ...mayanqueen, sinEnviar: 0 }])
  })

  it('orders by the date the oldest delivery has been waiting since, and puts the barcos with no date last', async () => {
    await seedBarco(db, { odooId: 680, nombre: 'ZULU' })
    await seedBarco(db, { odooId: 681, nombre: 'ECHO' })
    odooTiene(
      { barcoOdooId: 10, barcoNombre: 'DELTA', paquetes: 1, desde: new Date('2026-10-20T08:00:00Z') },
      { barcoOdooId: 13, barcoNombre: 'BRAVO', paquetes: 4, desde: new Date('2026-10-17T08:00:00Z') },
      { barcoOdooId: 12, barcoNombre: 'CHARLIE', paquetes: 1, desde: new Date('2026-10-14T08:00:00Z') },
      { barcoOdooId: 11, barcoNombre: 'ALFA', paquetes: 2, desde: new Date('2026-10-14T08:00:00Z') },
    )
    await recibirSinEnviar(mb92, 680, 1)
    await recibirSinEnviar(mb92, 681, 2)

    const barcos = await listarBarcosParaEntregar(mb92)

    // Two with the same date go by name (ALFA before CHARLIE); the two with none go by name too, not by id.
    expect(barcos.map((barco) => barco.barcoNombre)).toEqual(['ALFA', 'CHARLIE', 'BRAVO', 'DELTA', 'ECHO', 'ZULU'])
  })

  it('throws ConfiguracionError without a delivery type, and does not ask Odoo', async () => {
    const error = await listarBarcosParaEntregar({ id: mb92.id, odooOutTypeId: null }).catch((e) => e)

    expect(error).toBeInstanceOf(ConfiguracionError)
    expect(error.message).toBe('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')
    expect(getBarcosConEntregaPendiente).not.toHaveBeenCalled()
  })

  it('lets the error through when Odoo fails', async () => {
    vi.mocked(getBarcosConEntregaPendiente).mockRejectedValue(new Error('Odoo se cayó'))

    await expect(listarBarcosParaEntregar(mb92)).rejects.toThrow('Odoo se cayó')
  })
})

const filaSesion = async (id: string) =>
  (await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, id)))[0]

/** What the phone sends when the crew confirms: the lines chosen, the name typed and the signature as the canvas gives it. */
function entradaDeEntrega(datos: Partial<Parameters<typeof registrarEntrega>[0]> = {}): Parameters<typeof registrarEntrega>[0] {
  return {
    id: crypto.randomUUID(),
    operarioId: veronika.id,
    almacenId: mb92.id,
    barcoOdooId: 673,
    pickingIds: [700, 701],
    moveLineIds: [1, 2, 5],
    receptorNombre: 'Capitán Pérez',
    firmaBase64: 'data:image/png;base64,AAA',
    ...datos,
  }
}

describe('registrarEntrega', () => {
  it('is idempotent by id: a retry after a dropped connection publishes once, once the worker has synced it', async () => {
    const entrada = entradaDeEntrega()

    await registrarEntrega(entrada)
    // The first try went through and only the answer was lost: by the time the retry arrives, the worker is done.
    await db.update(sesionesEscaneo).set({ estado: 'sincronizada', syncedAt: new Date() }).where(eq(sesionesEscaneo.id, entrada.id))
    await registrarEntrega(entrada)

    expect(await db.select().from(sesionesEscaneo)).toHaveLength(1)
    expect(publishSync).toHaveBeenCalledTimes(1)
    expect(registrarAuditoria).toHaveBeenCalledTimes(1)
  })

  it('queues it again, and audits nothing again, when a retry finds it still waiting for its sync', async () => {
    const entrada = entradaDeEntrega()

    await registrarEntrega(entrada)
    await registrarEntrega(entrada)

    expect(await db.select().from(sesionesEscaneo)).toHaveLength(1)
    // A second message does no harm: the queue runs one job at a time, and the worker does nothing for an entrega
    // that is not waiting for its sync any more.
    expect(publishSync).toHaveBeenCalledTimes(2)
    expect(publishSync).toHaveBeenNthCalledWith(1, { sesionId: entrada.id })
    expect(publishSync).toHaveBeenNthCalledWith(2, { sesionId: entrada.id })
    expect(registrarAuditoria).toHaveBeenCalledTimes(1)
  })

  it('queues it on a retry with the same id when the first publish failed', async () => {
    vi.mocked(publishSync).mockRejectedValueOnce(new Error('QStash no responde'))
    const entrada = entradaDeEntrega()

    await expect(registrarEntrega(entrada)).rejects.toThrow('QStash no responde')
    expect(await filaSesion(entrada.id)).toMatchObject({ estado: 'confirmada_pendiente_sync' })

    await registrarEntrega(entrada) // publishing works again

    expect(publishSync).toHaveBeenCalledTimes(2)
    expect(publishSync).toHaveBeenLastCalledWith({ sesionId: entrada.id })
    expect(await db.select().from(sesionesEscaneo)).toHaveLength(1)
    // Exactly once: the first try audited it when it saved it, though publishing then failed, and the retry audits nothing.
    expect(registrarAuditoria).toHaveBeenCalledTimes(1)
    expect(registrarAuditoria).toHaveBeenCalledWith({
      operarioId: veronika.id,
      accion: 'entrega_confirmada',
      detalle: { sesionId: entrada.id, almacenId: mb92.id, barcoOdooId: 673, paquetes: 3 },
    })
  })

  it('fails the same way on a retry while publishing keeps failing, with the entrega still saved once', async () => {
    vi.mocked(publishSync).mockRejectedValue(new Error('QStash no responde'))
    const entrada = entradaDeEntrega()

    await expect(registrarEntrega(entrada)).rejects.toThrow('QStash no responde')
    await expect(registrarEntrega(entrada)).rejects.toThrow('QStash no responde')

    expect(publishSync).toHaveBeenCalledTimes(2)
    expect(await db.select().from(sesionesEscaneo)).toHaveLength(1)
    expect(await filaSesion(entrada.id)).toMatchObject({ estado: 'confirmada_pendiente_sync', receptorNombre: 'Capitán Pérez' })
    expect(registrarAuditoria).toHaveBeenCalledTimes(1) // by the first try; the retry audits nothing, however many times it fails
  })

  it.each(['error', 'en_curso'] as const)('does not queue a retry for an entrega that is %s', async (estado) => {
    const entrada = entradaDeEntrega()
    await registrarEntrega(entrada)
    // Only a waiting entrega is queued again: one that failed for good goes back through Pendientes' "Reintentar".
    await db.update(sesionesEscaneo).set({ estado }).where(eq(sesionesEscaneo.id, entrada.id))

    await registrarEntrega(entrada)

    expect(publishSync).toHaveBeenCalledTimes(1) // the first try's
    expect(registrarAuditoria).toHaveBeenCalledTimes(1)
    expect((await filaSesion(entrada.id)).estado).toBe(estado)
  })

  it('leaves alone an id that belongs to something other than an entrega: nothing is saved or queued', async () => {
    const [recepcion] = await db.insert(sesionesEscaneo).values({
      operarioId: veronika.id,
      almacenId: mb92.id,
      barcoOdooId: 673,
      tipo: 'recepcion',
      estado: 'confirmada_pendiente_sync',
      confirmedAt: new Date(),
    }).returning()

    await registrarEntrega(entradaDeEntrega({ id: recepcion.id }))

    expect(publishSync).not.toHaveBeenCalled()
    expect(registrarAuditoria).not.toHaveBeenCalled()
    expect(await db.select().from(sesionesEscaneo)).toHaveLength(1)
    expect(await filaSesion(recepcion.id)).toMatchObject({ tipo: 'recepcion', receptorNombre: null, odooPickingIds: null })
  })

  it('saves and audits once when the same entrega reaches the server twice at the same time', async () => {
    const entrada = entradaDeEntrega()

    await Promise.all([registrarEntrega(entrada), registrarEntrega(entrada)])

    expect(await db.select().from(sesionesEscaneo)).toHaveLength(1)
    expect(registrarAuditoria).toHaveBeenCalledTimes(1)
    // One of the two saved it. The other found it waiting and queued it again, which does no harm.
    expect(publishSync).toHaveBeenCalledTimes(2)
  })

  it('registers each id as an entrega of its own', async () => {
    const primera = entradaDeEntrega()
    const segunda = entradaDeEntrega()

    await registrarEntrega(primera)
    await registrarEntrega(segunda)

    expect(await db.select().from(sesionesEscaneo)).toHaveLength(2)
    expect(publishSync).toHaveBeenCalledTimes(2)
    expect(publishSync).toHaveBeenCalledWith({ sesionId: primera.id })
    expect(publishSync).toHaveBeenCalledWith({ sesionId: segunda.id })
  })

  it('stores the bare base64 and the trimmed crew name', async () => {
    const entrada = entradaDeEntrega({ receptorNombre: '  Capitán Pérez \n', firmaBase64: 'data:image/png;base64,iVBORw0KGgo=' })

    await registrarEntrega(entrada)

    expect(await filaSesion(entrada.id)).toMatchObject({ receptorNombre: 'Capitán Pérez', firmaData: 'iVBORw0KGgo=' })
  })

  it.each([
    ['another image type', 'data:image/jpeg;base64,/9j/4AAQ+x==', '/9j/4AAQ+x=='],
    ['a signature that is already bare', 'iVBORw0KGgo=', 'iVBORw0KGgo='],
  ])('keeps the whole signature, and only the signature, for %s', async (_caso, firmaBase64, guardada) => {
    const entrada = entradaDeEntrega({ firmaBase64 })

    await registrarEntrega(entrada)

    expect((await filaSesion(entrada.id)).firmaData).toBe(guardada)
  })

  it('saves it as an entrega waiting for its sync, with where, who, the pickings and the lines chosen', async () => {
    const entrada = entradaDeEntrega()

    await registrarEntrega(entrada)

    const fila = await filaSesion(entrada.id)
    expect(fila).toMatchObject({
      id: entrada.id,
      tipo: 'entrega',
      estado: 'confirmada_pendiente_sync',
      operarioId: veronika.id,
      almacenId: mb92.id,
      barcoOdooId: 673,
      odooPickingIds: [700, 701],
      odooMoveLineIds: [1, 2, 5],
      intentos: 0,
      ultimoError: null,
      ultimoErrorTipo: null,
      syncedAt: null,
    })
    expect(Math.abs((fila.confirmedAt as Date).getTime() - Date.now())).toBeLessThan(5_000)
  })

  it('queues the entrega once it is saved, and audits it', async () => {
    let vistaAlEncolar: Awaited<ReturnType<typeof filaSesion>> | undefined
    vi.mocked(publishSync).mockImplementation(async ({ sesionId }) => {
      vistaAlEncolar = await filaSesion(sesionId)
    })
    const entrada = entradaDeEntrega()

    await registrarEntrega(entrada)

    expect(publishSync).toHaveBeenCalledWith({ sesionId: entrada.id })
    // The worker looks the entrega up the moment it gets the message: it has to be there already.
    expect(vistaAlEncolar).toMatchObject({ id: entrada.id, estado: 'confirmada_pendiente_sync' })
    expect(registrarAuditoria).toHaveBeenCalledWith({
      operarioId: veronika.id,
      accion: 'entrega_confirmada',
      detalle: { sesionId: entrada.id, almacenId: mb92.id, barcoOdooId: 673, paquetes: 3 },
    })
  })

  it('audits the confirmation as soon as the entrega is saved, before queuing it', async () => {
    const entrada = entradaDeEntrega()

    await registrarEntrega(entrada)

    expect(registrarAuditoria).toHaveBeenCalledTimes(1)
    expect(publishSync).toHaveBeenCalledTimes(1)
    expect(vi.mocked(registrarAuditoria).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(publishSync).mock.invocationCallOrder[0])
  })

  it('lets the error through when publishing fails, and keeps the entrega, already audited', async () => {
    vi.mocked(publishSync).mockRejectedValue(new Error('QStash no responde'))
    const entrada = entradaDeEntrega()

    await expect(registrarEntrega(entrada)).rejects.toThrow('QStash no responde')

    expect(await filaSesion(entrada.id)).toMatchObject({ estado: 'confirmada_pendiente_sync', receptorNombre: 'Capitán Pérez' })
    // The confirmation is a fact as soon as the entrega is saved, whatever then happens to the queue.
    expect(registrarAuditoria).toHaveBeenCalledTimes(1)
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({ accion: 'entrega_confirmada' }))
  })
})

describe('listarEntregadasHoy', () => {
  // 12:00 in Madrid (summer time), so "today" began at 00:00 Madrid time, 22:00 UTC the day before.
  const AHORA = new Date('2026-10-22T10:00:00Z')

  /** An entrega confirmed at `confirmedAt`, written straight to the database so that it can be in any estado. */
  async function entregada(
    barcoOdooId: number,
    confirmedAt: string,
    estado: typeof sesionesEscaneo.$inferInsert['estado'],
    datos: Partial<typeof sesionesEscaneo.$inferInsert> = {},
  ) {
    const [sesion] = await db.insert(sesionesEscaneo).values({
      operarioId: veronika.id,
      almacenId: mb92.id,
      barcoOdooId,
      tipo: 'entrega',
      estado,
      odooPickingIds: [700],
      odooMoveLineIds: [1, 2],
      receptorNombre: 'Capitán Pérez',
      firmaData: 'AAA',
      confirmedAt: new Date(confirmedAt),
      ...datos,
    }).returning()
    return sesion
  }

  it('shows who received and the estado of each one, with its packages, for today in Madrid time only', async () => {
    await seedBarco(db, { odooId: 677, nombre: 'ARCTIC' })
    // Today, saved out of the order they were confirmed in: the list goes by when each was confirmed.
    const enviando = await entregada(676, '2026-10-22T09:55:00Z', 'confirmada_pendiente_sync')
    const conError = await entregada(675, '2026-10-22T09:00:00Z', 'error', { receptorNombre: 'Marta Gil' })
    const conNota = await entregada(674, '2026-10-22T08:30:00Z', 'sincronizada', { receptorNombre: 'Luis Soto', ultimoError: 'Una nota' })
    const ok = await entregada(673, '2026-10-22T08:00:00Z', 'sincronizada', { odooMoveLineIds: [1, 2, 3] })
    const justoHoy = await entregada(677, '2026-10-21T22:00:00Z', 'sincronizada', { receptorNombre: 'Ana Ruiz', odooMoveLineIds: [9] })
    // Not in the list: one second before today began, another almacén, a recepción, one still open.
    await entregada(678, '2026-10-21T21:59:59Z', 'sincronizada')
    const mpv = await seedAlmacen(db, { prefijo: 'MPV', nombre: 'Port Vell (MPV)', odooWarehouseId: 2, odooInTypeId: 9, odooOutTypeId: 10 })
    await entregada(680, '2026-10-22T09:00:00Z', 'sincronizada', { almacenId: mpv.id })
    await entregada(681, '2026-10-22T09:00:00Z', 'sincronizada', { tipo: 'recepcion', receptorNombre: null, odooMoveLineIds: null })
    await entregada(682, '2026-10-22T09:00:00Z', 'en_curso')

    expect(await listarEntregadasHoy(mb92.id, AHORA)).toEqual([
      { id: justoHoy.id, barcoNombre: 'ARCTIC', paquetes: 1, receptorNombre: 'Ana Ruiz', estado: 'ok' },
      { id: ok.id, barcoNombre: 'MAYANQUEEN', paquetes: 3, receptorNombre: 'Capitán Pérez', estado: 'ok' },
      // It synced, but with a note in ultimoError: somebody has to look.
      { id: conNota.id, barcoNombre: 'MAYANQUEENIV', paquetes: 2, receptorNombre: 'Luis Soto', estado: 'problema' },
      { id: conError.id, barcoNombre: 'Barco #675', paquetes: 2, receptorNombre: 'Marta Gil', estado: 'problema' },
      { id: enviando.id, barcoNombre: 'Barco #676', paquetes: 2, receptorNombre: 'Capitán Pérez', estado: 'enviando' },
    ])
  })

  it('counts the whole day in Madrid time, not in UTC: 23:30 UTC of the day before is already today', async () => {
    // 2026-12-02 10:00 UTC is 11:00 in Madrid (winter time): today began at 23:00 UTC of the day before.
    const ahora = new Date('2026-12-02T10:00:00Z')
    const hoy = await entregada(673, '2026-12-01T23:30:00Z', 'sincronizada')
    await entregada(674, '2026-12-01T22:59:59Z', 'sincronizada')

    expect((await listarEntregadasHoy(mb92.id, ahora)).map((entrega) => entrega.id)).toEqual([hoy.id])
  })

  it('takes the moment it is called as "now" when no date is given', async () => {
    const reciente = await entregada(673, '2026-10-22T09:59:00Z', 'confirmada_pendiente_sync')
    await entregada(674, '2026-10-19T09:59:00Z', 'sincronizada') // three days ago
    vi.useFakeTimers({ toFake: ['Date'] }) // only the clock: the database driver still needs its timers
    vi.setSystemTime(AHORA)

    try {
      expect((await listarEntregadasHoy(mb92.id)).map((entrega) => entrega.id)).toEqual([reciente.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers an empty list when nothing was delivered today', async () => {
    expect(await listarEntregadasHoy(mb92.id, AHORA)).toEqual([])
  })
})

describe('entregaGuardada', () => {
  it('knows an entrega that an earlier try saved, whatever became of its sync', async () => {
    for (const estado of ['confirmada_pendiente_sync', 'sincronizada', 'error'] as const) {
      const entrada = entradaDeEntrega()
      await registrarEntrega(entrada)
      await db.update(sesionesEscaneo).set({ estado }).where(eq(sesionesEscaneo.id, entrada.id))

      expect(await entregaGuardada(entrada.id, mb92.id)).toBe(true)
    }
  })

  it('does not know an id nobody saved', async () => {
    expect(await entregaGuardada(crypto.randomUUID(), mb92.id)).toBe(false)
  })

  it('does not know an entrega of another almacén: a retry is a retry in the same almacén', async () => {
    const tgn = await seedAlmacen(db, { prefijo: 'TGN', nombre: 'Port Tarraco (TGN)', odooWarehouseId: 5, odooInTypeId: 21, odooOutTypeId: 22 })
    const entrada = entradaDeEntrega({ almacenId: tgn.id })
    await registrarEntrega(entrada)

    expect(await entregaGuardada(entrada.id, mb92.id)).toBe(false)
    expect(await entregaGuardada(entrada.id, tgn.id)).toBe(true)
  })

  it('does not take a recepción for an entrega', async () => {
    const [recepcion] = await db.insert(sesionesEscaneo).values({
      operarioId: veronika.id, almacenId: mb92.id, barcoOdooId: 673, tipo: 'recepcion', estado: 'confirmada_pendiente_sync', confirmedAt: new Date(),
    }).returning()

    expect(await entregaGuardada(recepcion.id, mb92.id)).toBe(false)
  })
})
