import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
// Nothing here reaches Odoo: the four calls that have their own module are replaced, and so is odooCall,
// which is what the worker uses to read the picking and to leave the note and Recibido por.
vi.mock('@/lib/odoo/pickings', () => ({
  checkDuplicateTrackingNumbers: vi.fn(),
  createIncomingPicking: vi.fn(),
  addCourierMoveWithLines: vi.fn(),
  validatePicking: vi.fn(),
}))
vi.mock('@/lib/odoo/client', () => ({ odooCall: vi.fn() }))
// recordSyncedTrackings stays the real one (it writes tracking_activos_cache, which is PGlite like the rest);
// it is a spy only to see what each courier batch hands it.
vi.mock('@/lib/cache/trackingActivos', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cache/trackingActivos')>()
  return { ...real, recordSyncedTrackings: vi.fn(real.recordSyncedTrackings) }
})

import { asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  auditLog, sesionCourierBatches, sesionItems, sesionesEscaneo, trackingActivosCache,
  type Almacen, type Courier, type Operario,
} from '@/db/schema'
import { recordSyncedTrackings } from '@/lib/cache/trackingActivos'
import { ConfiguracionError } from '@/lib/errores'
import { odooCall } from '@/lib/odoo/client'
import {
  addCourierMoveWithLines, checkDuplicateTrackingNumbers, createIncomingPicking, validatePicking,
} from '@/lib/odoo/pickings'
import { seedAlmacen, seedCourier, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { syncRecepcionSession } from './recepcion'

const PICKING_ID = 501
const PICKING_REF = 'MB92/IN/00231'
const RECIBIDO_POR = 'x_studio_recibido_por_2'

let veronika: Operario
let eduardo: Operario
let mb92: Almacen
let dhl: Courier // Odoo product 11
let gls: Courier // Odoo product 12
/** The state Odoo reports for the picking when the worker asks before validating it. */
let estadoDelPicking: string
/** The next scan time, in seconds after 08:00, for a package that does not say when it was scanned. */
let segundo: number

/** The picking as Odoo has it. It answers only the fields it is asked for, like the real `read`. */
function odooResponde(modelo: string, metodo: string, params: Record<string, unknown> = {}): unknown {
  if (modelo === 'stock.picking' && metodo === 'read') {
    const { ids, fields } = params as { ids: number[]; fields: string[] }
    if (ids[0] !== PICKING_ID) return []
    const campos: Record<string, unknown> = {
      id: PICKING_ID,
      name: PICKING_REF,
      state: estadoDelPicking,
      location_id: [1, 'Partners/Vendors'],
      location_dest_id: [5, 'MB92/Stock'],
    }
    return [Object.fromEntries(['id', ...fields].map((campo) => [campo, campos[campo]]))]
  }
  return true // message_post, write
}

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  estadoDelPicking = 'assigned'
  segundo = 0
  vi.stubEnv('ODOO_FIELD_RECIBIDO_POR', RECIBIDO_POR)

  veronika = await seedOperario(db, { nombre: 'Veronika' })
  eduardo = await seedOperario(db, { nombre: 'Eduardo' })
  mb92 = await seedAlmacen(db) // receives with operation type 1, delivers with 2
  dhl = await seedCourier(db)
  gls = await seedCourier(db, { nombre: 'GLS', odooProductId: 12 })

  vi.mocked(checkDuplicateTrackingNumbers).mockResolvedValue(new Map())
  vi.mocked(createIncomingPicking).mockResolvedValue(PICKING_ID)
  vi.mocked(addCourierMoveWithLines).mockImplementation(async (_pickingId, productId) => 900 + productId)
  vi.mocked(validatePicking).mockResolvedValue(undefined)
  vi.mocked(odooCall).mockImplementation(async (modelo, metodo, params) => odooResponde(modelo, metodo, params) as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

interface PaqueteSembrado {
  tracking: string
  /** Who scanned it: Veronika unless said; null for a package from before the webapp kept that. */
  operario?: Operario | null
  estado?: 'ok' | 'duplicado' | 'sincronizado'
  duplicadoRef?: string
  /** When it was scanned, in seconds after 08:00. Each package is a second after the last one unless said. */
  t?: number
}

interface TandaSembrada {
  courier: Courier
  odooMoveId?: number
  paquetes: PaqueteSembrado[]
}

/**
 * A recepción waiting for its sync, written straight to the database with its courier batches and packages.
 * PGlite's clock ticks once per millisecond, so the scan time is explicit: "the order of the first scan"
 * is never left to insertion order.
 */
async function crearRecepcion(tandas: TandaSembrada[], datos: Partial<typeof sesionesEscaneo.$inferInsert> = {}) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: veronika.id,
    almacenId: mb92.id,
    barcoOdooId: 673,
    tipo: 'recepcion',
    estado: 'confirmada_pendiente_sync',
    ...datos,
  }).returning()
  for (const tanda of tandas) {
    const [creada] = await db.insert(sesionCourierBatches)
      .values({ sesionId: sesion.id, courierId: tanda.courier.id, odooMoveId: tanda.odooMoveId ?? null })
      .returning()
    for (const { tracking, operario = veronika, estado = 'ok', duplicadoRef = null, t = segundo++ } of tanda.paquetes) {
      await db.insert(sesionItems).values({
        courierBatchId: creada.id,
        trackingNumber: tracking,
        estado,
        duplicadoRef,
        operarioId: operario?.id ?? null,
        createdAt: new Date(Date.UTC(2026, 9, 22, 8, 0, t)),
      })
    }
  }
  return sesion
}

const filaSesion = async (id: string) =>
  (await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, id)))[0]

/** What is stored for each package of the recepción, by tracking number. */
const paquetes = (sesionId: string) =>
  db.select({
    trackingNumber: sesionItems.trackingNumber,
    estado: sesionItems.estado,
    duplicadoAlEnviar: sesionItems.duplicadoAlEnviar,
    duplicadoRef: sesionItems.duplicadoRef,
  })
    .from(sesionItems)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.id, sesionItems.courierBatchId))
    .where(eq(sesionCourierBatches.sesionId, sesionId))
    .orderBy(asc(sesionItems.trackingNumber))

/** The Odoo move of each courier batch of the recepción, by courier. */
const movimientos = (sesionId: string) =>
  db.select({ courierId: sesionCourierBatches.courierId, odooMoveId: sesionCourierBatches.odooMoveId })
    .from(sesionCourierBatches)
    .where(eq(sesionCourierBatches.sesionId, sesionId))
    .orderBy(asc(sesionCourierBatches.courierId))

/** The params of every call made to Odoo through odooCall with this model and method, in order. */
const llamadasAOdoo = (modelo: string, metodo: string) =>
  vi.mocked(odooCall).mock.calls.filter(([m, me]) => m === modelo && me === metodo).map(([, , params]) => params)

/** Where in the run of all the mocks a call of `odooCall` with this method happened. */
const ordenDeOdoo = (metodo: string) =>
  vi.mocked(odooCall).mock.invocationCallOrder[vi.mocked(odooCall).mock.calls.findIndex(([, me]) => me === metodo)]

describe('syncRecepcionSession', () => {
  it('creates the picking with the almacén reception type and stores its reference', async () => {
    const sesion = await crearRecepcion([{ courier: dhl, paquetes: [{ tracking: 'T1' }] }])

    await syncRecepcionSession(sesion.id)

    expect(createIncomingPicking).toHaveBeenCalledWith(1, 673) // MB92 receives with type 1; its delivery type is 2
    expect(await filaSesion(sesion.id)).toMatchObject({
      estado: 'sincronizada',
      odooPickingId: PICKING_ID,
      odooPickingRef: PICKING_REF,
    })
  })

  it('adds one move per courier with all its packages, validates, and marks the packages synced', async () => {
    const sesion = await crearRecepcion([
      { courier: dhl, paquetes: [{ tracking: 'T1' }, { tracking: 'T3' }] },
      { courier: gls, paquetes: [{ tracking: 'T2' }] },
    ])

    await syncRecepcionSession(sesion.id)

    expect(addCourierMoveWithLines).toHaveBeenCalledTimes(2)
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(PICKING_ID, 11, ['T1', 'T3'], 1, 5)
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(PICKING_ID, 12, ['T2'], 1, 5)
    expect(validatePicking).toHaveBeenCalledWith(PICKING_ID)
    expect(await paquetes(sesion.id)).toEqual([
      { trackingNumber: 'T1', estado: 'sincronizado', duplicadoAlEnviar: false, duplicadoRef: null },
      { trackingNumber: 'T2', estado: 'sincronizado', duplicadoAlEnviar: false, duplicadoRef: null },
      { trackingNumber: 'T3', estado: 'sincronizado', duplicadoAlEnviar: false, duplicadoRef: null },
    ])
    expect(await movimientos(sesion.id)).toEqual([
      { courierId: dhl.id, odooMoveId: 911 },
      { courierId: gls.id, odooMoveId: 912 },
    ])
  })

  it('puts the packages of a courier in its move in the order they were scanned', async () => {
    const sesion = await crearRecepcion([{ courier: dhl, paquetes: [
      // Seeded out of scan order on purpose.
      { tracking: 'T1', t: 3 }, { tracking: 'T2', t: 1 }, { tracking: 'T3', t: 2 },
    ] }])

    await syncRecepcionSession(sesion.id)

    expect(addCourierMoveWithLines).toHaveBeenCalledWith(PICKING_ID, 11, ['T2', 'T3', 'T1'], 1, 5)
  })

  it('asks Odoo for the picking once before the moves, and does the rest in the order Odoo needs', async () => {
    const sesion = await crearRecepcion([
      { courier: dhl, paquetes: [{ tracking: 'T1' }] },
      { courier: gls, paquetes: [{ tracking: 'T2' }] },
    ])

    await syncRecepcionSession(sesion.id)

    // The locations and the name in one read, then the state before validating; nothing per batch or per package.
    expect(vi.mocked(odooCall).mock.calls.map(([, metodo]) => metodo)).toEqual(['read', 'read', 'message_post', 'write'])
    expect(vi.mocked(odooCall).mock.calls[0]).toEqual([
      'stock.picking', 'read', { ids: [PICKING_ID], fields: ['location_id', 'location_dest_id', 'name'] },
    ])
    const orden = {
      crear: vi.mocked(createIncomingPicking).mock.invocationCallOrder[0],
      leer: vi.mocked(odooCall).mock.invocationCallOrder[0],
      mover: Math.min(...vi.mocked(addCourierMoveWithLines).mock.invocationCallOrder),
      ultimoMover: Math.max(...vi.mocked(addCourierMoveWithLines).mock.invocationCallOrder),
      validar: vi.mocked(validatePicking).mock.invocationCallOrder[0],
      nota: ordenDeOdoo('message_post'),
      recibidoPor: ordenDeOdoo('write'),
    }
    expect(orden.crear).toBeLessThan(orden.leer)
    expect(orden.leer).toBeLessThan(orden.mover) // the moves need the picking's locations
    expect(orden.ultimoMover).toBeLessThan(orden.validar)
    expect(orden.validar).toBeLessThan(orden.nota)
    expect(orden.nota).toBeLessThan(orden.recibidoPor)
  })

  it('records the synced tracking numbers in the cache with the picking reference, one bulk upsert per batch', async () => {
    const sesion = await crearRecepcion([
      { courier: dhl, paquetes: [{ tracking: 'T1' }] },
      { courier: gls, paquetes: [{ tracking: 'T2' }] },
    ])

    await syncRecepcionSession(sesion.id)

    expect(recordSyncedTrackings).toHaveBeenCalledTimes(2)
    expect(recordSyncedTrackings).toHaveBeenCalledWith([
      { trackingNumber: 'T1', odooPickingId: PICKING_ID, odooPickingRef: PICKING_REF },
    ])
    expect(recordSyncedTrackings).toHaveBeenCalledWith([
      { trackingNumber: 'T2', odooPickingId: PICKING_ID, odooPickingRef: PICKING_REF },
    ])
    expect(await db.select().from(trackingActivosCache).orderBy(asc(trackingActivosCache.trackingNumber))).toMatchObject([
      { trackingNumber: 'T1', odooPickingId: PICKING_ID, odooPickingRef: PICKING_REF },
      { trackingNumber: 'T2', odooPickingId: PICKING_ID, odooPickingRef: PICKING_REF },
    ])
  })

  describe('who is named in Recibido por and in the chatter note', () => {
    it('writes the names of the scanners, not their ids', async () => {
      const sesion = await crearRecepcion([
        { courier: dhl, paquetes: [{ tracking: 'T1', operario: veronika }] },
        { courier: gls, paquetes: [{ tracking: 'T2', operario: eduardo }] },
      ])

      await syncRecepcionSession(sesion.id)

      expect(odooCall).toHaveBeenCalledWith('stock.picking', 'write', {
        ids: [PICKING_ID],
        vals: { [RECIBIDO_POR]: 'Veronika, Eduardo' },
      })
      expect(odooCall).toHaveBeenCalledWith('stock.picking', 'message_post', {
        ids: [PICKING_ID],
        body: 'Registrado vía Webapp Paquetería por Veronika, Eduardo',
      })
    })

    it('names each scanner once, in the order of their first scan', async () => {
      const ana = await seedOperario(db, { nombre: 'Ana' }) // created after the others, and first in the alphabet
      const sesion = await crearRecepcion([
        // Seeded out of scan order on purpose: Veronika scanned first, then Ana, then Eduardo, and each of
        // Veronika and Eduardo scanned again later.
        { courier: dhl, paquetes: [
          { tracking: 'T1', operario: eduardo, t: 3 },
          { tracking: 'T2', operario: veronika, t: 6 },
        ] },
        { courier: gls, paquetes: [
          { tracking: 'T3', operario: veronika, t: 1 },
          { tracking: 'T4', operario: ana, t: 2 },
          { tracking: 'T5', operario: eduardo, t: 5 },
        ] },
      ])

      await syncRecepcionSession(sesion.id)

      expect(llamadasAOdoo('stock.picking', 'write')).toEqual([
        { ids: [PICKING_ID], vals: { [RECIBIDO_POR]: 'Veronika, Ana, Eduardo' } },
      ])
    })

    it('names the operario who opened the recepción for packages from before the webapp kept who scanned', async () => {
      const sesion = await crearRecepcion(
        [{ courier: dhl, paquetes: [{ tracking: 'T1', operario: null }, { tracking: 'T2', operario: null }] }],
        { operarioId: eduardo.id },
      )

      await syncRecepcionSession(sesion.id)

      expect(llamadasAOdoo('stock.picking', 'write')).toEqual([{ ids: [PICKING_ID], vals: { [RECIBIDO_POR]: 'Eduardo' } }])
      expect(llamadasAOdoo('stock.picking', 'message_post')).toEqual([
        { ids: [PICKING_ID], body: 'Registrado vía Webapp Paquetería por Eduardo' },
      ])
    })

    it('puts the operario who opened the recepción where its old packages were scanned, among the other scanners', async () => {
      const sesion = await crearRecepcion(
        [{ courier: dhl, paquetes: [
          { tracking: 'T1', operario: veronika, t: 2 },
          { tracking: 'T2', operario: null, t: 1 },
        ] }],
        { operarioId: eduardo.id },
      )

      await syncRecepcionSession(sesion.id)

      expect(llamadasAOdoo('stock.picking', 'write')).toEqual([
        { ids: [PICKING_ID], vals: { [RECIBIDO_POR]: 'Eduardo, Veronika' } },
      ])
    })

    it('leaves out whoever scanned only packages that did not go in the picking because they were duplicates', async () => {
      const ana = await seedOperario(db, { nombre: 'Ana' })
      const sesion = await crearRecepcion([{ courier: dhl, paquetes: [
        { tracking: 'T1', operario: veronika },
        { tracking: 'T2', operario: eduardo }, // Odoo turns out to have it when sending
        { tracking: 'T3', operario: ana, estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' }, // the cache knew it when scanning
      ] }])
      vi.mocked(checkDuplicateTrackingNumbers).mockResolvedValue(new Map([['T2', 'MB92/IN/00010']]))

      await syncRecepcionSession(sesion.id)

      expect(llamadasAOdoo('stock.picking', 'write')).toEqual([{ ids: [PICKING_ID], vals: { [RECIBIDO_POR]: 'Veronika' } }])
    })

    it('names the operario who opened the recepción when no package went in the picking', async () => {
      const sesion = await crearRecepcion([{ courier: dhl, paquetes: [{ tracking: 'T1', operario: eduardo }] }])
      vi.mocked(checkDuplicateTrackingNumbers).mockResolvedValue(new Map([['T1', 'MB92/IN/00010']]))

      await syncRecepcionSession(sesion.id)

      expect(llamadasAOdoo('stock.picking', 'message_post')).toEqual([
        { ids: [PICKING_ID], body: 'Registrado vía Webapp Paquetería por Veronika' },
      ])
    })

    it('leaves the note but writes no Recibido por when the field is not configured', async () => {
      vi.stubEnv('ODOO_FIELD_RECIBIDO_POR', undefined)
      const sesion = await crearRecepcion([{ courier: dhl, paquetes: [{ tracking: 'T1' }] }])

      await syncRecepcionSession(sesion.id)

      expect(llamadasAOdoo('stock.picking', 'write')).toEqual([])
      expect(llamadasAOdoo('stock.picking', 'message_post')).toHaveLength(1)
      expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
    })
  })

  describe('duplicates', () => {
    it('checks the live duplicates once for the whole session, not once per batch', async () => {
      const sesion = await crearRecepcion([
        { courier: dhl, paquetes: [{ tracking: 'T1' }] },
        { courier: gls, paquetes: [{ tracking: 'T2' }] },
      ])

      await syncRecepcionSession(sesion.id)

      expect(checkDuplicateTrackingNumbers).toHaveBeenCalledTimes(1)
      // Sorted: the order of the batches among themselves is not what is being checked.
      expect([...vi.mocked(checkDuplicateTrackingNumbers).mock.calls[0][0]].sort()).toEqual(['T1', 'T2'])
    })

    it('marks live duplicates as found while sending, each with the Odoo picking that has it, and syncs the rest', async () => {
      const sesion = await crearRecepcion([
        { courier: dhl, paquetes: [{ tracking: 'T1' }, { tracking: 'T2' }, { tracking: 'T3' }, { tracking: 'T5' }] },
        { courier: gls, paquetes: [{ tracking: 'T4' }] },
      ])
      vi.mocked(checkDuplicateTrackingNumbers).mockResolvedValue(new Map([
        ['T1', 'MB92/IN/00010'],
        ['T3', 'MB92/IN/00011'],
        ['T5', 'MB92/IN/00010'], // the same picking as T1
      ]))

      await syncRecepcionSession(sesion.id)

      expect(vi.mocked(addCourierMoveWithLines).mock.calls).toHaveLength(2)
      expect(addCourierMoveWithLines).toHaveBeenCalledWith(PICKING_ID, 11, ['T2'], 1, 5)
      expect(addCourierMoveWithLines).toHaveBeenCalledWith(PICKING_ID, 12, ['T4'], 1, 5)
      expect(await paquetes(sesion.id)).toEqual([
        { trackingNumber: 'T1', estado: 'duplicado', duplicadoAlEnviar: true, duplicadoRef: 'MB92/IN/00010' },
        { trackingNumber: 'T2', estado: 'sincronizado', duplicadoAlEnviar: false, duplicadoRef: null },
        { trackingNumber: 'T3', estado: 'duplicado', duplicadoAlEnviar: true, duplicadoRef: 'MB92/IN/00011' },
        { trackingNumber: 'T4', estado: 'sincronizado', duplicadoAlEnviar: false, duplicadoRef: null },
        { trackingNumber: 'T5', estado: 'duplicado', duplicadoAlEnviar: true, duplicadoRef: 'MB92/IN/00010' },
      ])
      // Some packages went in, so this is not the "everything was a duplicate" case.
      expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'sincronizada', ultimoError: null })
      // The cache is told about what went in, not about what was left out.
      expect(vi.mocked(recordSyncedTrackings).mock.calls.flatMap(([filas]) => filas.map((fila) => fila.trackingNumber)).sort())
        .toEqual(['T2', 'T4'])
    })

    it('flags a duplicate only in its own recepción, not in an earlier one that has the same tracking number', async () => {
      const anterior = await crearRecepcion(
        [{ courier: dhl, paquetes: [{ tracking: 'T1', estado: 'sincronizado' }] }],
        { estado: 'sincronizada', odooPickingId: 400, odooPickingRef: 'MB92/IN/00200' },
      )
      const sesion = await crearRecepcion([{ courier: dhl, paquetes: [{ tracking: 'T1' }, { tracking: 'T2' }] }])
      vi.mocked(checkDuplicateTrackingNumbers).mockResolvedValue(new Map([['T1', 'MB92/IN/00200']]))

      await syncRecepcionSession(sesion.id)

      expect(await paquetes(anterior.id)).toEqual([
        { trackingNumber: 'T1', estado: 'sincronizado', duplicadoAlEnviar: false, duplicadoRef: null },
      ])
      expect(await paquetes(sesion.id)).toEqual([
        { trackingNumber: 'T1', estado: 'duplicado', duplicadoAlEnviar: true, duplicadoRef: 'MB92/IN/00200' },
        { trackingNumber: 'T2', estado: 'sincronizado', duplicadoAlEnviar: false, duplicadoRef: null },
      ])
    })

    it('never sends a package flagged as a duplicate when it was scanned, and leaves it as it was', async () => {
      const sesion = await crearRecepcion([
        { courier: dhl, paquetes: [{ tracking: 'T1', estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' }] },
        { courier: gls, paquetes: [{ tracking: 'T2' }] },
      ])

      await syncRecepcionSession(sesion.id)

      expect(checkDuplicateTrackingNumbers).toHaveBeenCalledWith(['T2'])
      expect(addCourierMoveWithLines).toHaveBeenCalledTimes(1)
      expect(addCourierMoveWithLines).toHaveBeenCalledWith(PICKING_ID, 12, ['T2'], 1, 5)
      expect(await paquetes(sesion.id)).toEqual([
        // It was caught when scanned, not while sending.
        { trackingNumber: 'T1', estado: 'duplicado', duplicadoAlEnviar: false, duplicadoRef: 'MB92/IN/00198' },
        { trackingNumber: 'T2', estado: 'sincronizado', duplicadoAlEnviar: false, duplicadoRef: null },
      ])
    })

    it('does not validate a picking without moves when every package is a duplicate, and closes the recepción with a note', async () => {
      const sesion = await crearRecepcion(
        [
          { courier: dhl, paquetes: [{ tracking: 'T1' }] },
          { courier: gls, paquetes: [{ tracking: 'T2' }] },
        ],
        { ultimoErrorTipo: 'conexion' }, // from an earlier attempt that did not finish
      )
      vi.mocked(checkDuplicateTrackingNumbers).mockImplementation(
        async (trackings) => new Map(trackings.map((t) => [t, 'MB92/IN/00010'])),
      )

      await syncRecepcionSession(sesion.id)

      expect(addCourierMoveWithLines).not.toHaveBeenCalled()
      expect(validatePicking).not.toHaveBeenCalled()
      // The recepción closes instead of failing forever; the note is what Pendientes shows.
      expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'sincronizada', ultimoErrorTipo: null })
      expect((await filaSesion(sesion.id)).ultimoError).toMatch(/duplicados/)
      expect((await paquetes(sesion.id)).every((p) => p.estado === 'duplicado' && p.duplicadoAlEnviar)).toBe(true)
    })
  })

  describe('recepciones with nothing to send', () => {
    it('finishes a recepción without packages quietly, without the all-duplicates note', async () => {
      const sesion = await crearRecepcion([])

      await syncRecepcionSession(sesion.id)

      expect(addCourierMoveWithLines).not.toHaveBeenCalled()
      expect(validatePicking).not.toHaveBeenCalled()
      expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'sincronizada', ultimoError: null, odooPickingRef: PICKING_REF })
    })

    it('tolerates a courier batch whose packages were all taken out, even if the courier has no Odoo product', async () => {
      const sinProducto = await seedCourier(db, { nombre: 'Sin producto', odooProductId: null })
      const sesion = await crearRecepcion([
        { courier: sinProducto, paquetes: [] },
        { courier: gls, paquetes: [{ tracking: 'T2' }] },
      ])

      await syncRecepcionSession(sesion.id)

      expect(addCourierMoveWithLines).toHaveBeenCalledTimes(1)
      expect(addCourierMoveWithLines).toHaveBeenCalledWith(PICKING_ID, 12, ['T2'], 1, 5)
      expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
    })
  })

  describe('a retry after a failed attempt', () => {
    it('does not create the picking again', async () => {
      const sesion = await crearRecepcion([{ courier: dhl, paquetes: [{ tracking: 'T1' }] }], { odooPickingId: PICKING_ID })

      await syncRecepcionSession(sesion.id)

      expect(createIncomingPicking).not.toHaveBeenCalled()
      expect(addCourierMoveWithLines).toHaveBeenCalledWith(PICKING_ID, 11, ['T1'], 1, 5)
      expect(await filaSesion(sesion.id)).toMatchObject({
        estado: 'sincronizada', odooPickingId: PICKING_ID, odooPickingRef: PICKING_REF,
      })
    })

    it('skips a batch that already has its move, and does not look its packages up as duplicates', async () => {
      const sesion = await crearRecepcion(
        [
          { courier: dhl, odooMoveId: 900, paquetes: [{ tracking: 'T1', estado: 'sincronizado' }] },
          { courier: gls, paquetes: [{ tracking: 'T2' }] },
        ],
        { odooPickingId: PICKING_ID, odooPickingRef: PICKING_REF },
      )

      await syncRecepcionSession(sesion.id)

      // T1 is already in the picking: looking it up would find itself and flag it as its own duplicate.
      expect(checkDuplicateTrackingNumbers).toHaveBeenCalledWith(['T2'])
      expect(addCourierMoveWithLines).toHaveBeenCalledTimes(1)
      expect(addCourierMoveWithLines).toHaveBeenCalledWith(PICKING_ID, 12, ['T2'], 1, 5)
      expect(await movimientos(sesion.id)).toEqual([
        { courierId: dhl.id, odooMoveId: 900 },
        { courierId: gls.id, odooMoveId: 912 },
      ])
      expect(validatePicking).toHaveBeenCalledWith(PICKING_ID) // the earlier move counts: there is something to validate
    })

    it('picks up where the failed attempt stopped, and nothing already made in Odoo is made twice', async () => {
      const sesion = await crearRecepcion([
        { courier: dhl, paquetes: [{ tracking: 'T1' }] },
        { courier: gls, paquetes: [{ tracking: 'T2' }] },
      ])
      vi.mocked(validatePicking).mockRejectedValueOnce(new Error('Odoo se cayó'))

      await expect(syncRecepcionSession(sesion.id)).rejects.toThrow('Odoo se cayó')
      // What the failed attempt did is kept: the picking, its reference and the moves.
      expect(await filaSesion(sesion.id)).toMatchObject({
        estado: 'confirmada_pendiente_sync', odooPickingId: PICKING_ID, odooPickingRef: PICKING_REF,
      })

      await syncRecepcionSession(sesion.id)

      expect(createIncomingPicking).toHaveBeenCalledTimes(1)
      expect(addCourierMoveWithLines).toHaveBeenCalledTimes(2)
      expect(validatePicking).toHaveBeenCalledTimes(2)
      expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'sincronizada', odooPickingRef: PICKING_REF })
    })

    it.each(['done', 'cancel'])('does not validate a picking that Odoo already has in state %s, but finishes the sync', async (estado) => {
      estadoDelPicking = estado
      const sesion = await crearRecepcion([{ courier: dhl, paquetes: [{ tracking: 'T1' }] }])

      await syncRecepcionSession(sesion.id)

      expect(validatePicking).not.toHaveBeenCalled()
      expect(llamadasAOdoo('stock.picking', 'message_post')).toHaveLength(1)
      expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
    })

    it('throws a readable error when the picking no longer exists in Odoo', async () => {
      const sesion = await crearRecepcion([{ courier: dhl, paquetes: [{ tracking: 'T1' }] }], { odooPickingId: 999 })

      await expect(syncRecepcionSession(sesion.id)).rejects.toThrow('picking 999 no existe en Odoo')

      expect(addCourierMoveWithLines).not.toHaveBeenCalled()
      expect((await filaSesion(sesion.id)).estado).toBe('confirmada_pendiente_sync')
    })
  })

  describe('when it succeeds', () => {
    it('leaves the recepción synced with nothing left over from earlier attempts, and audits it', async () => {
      const sesion = await crearRecepcion(
        [{ courier: dhl, paquetes: [{ tracking: 'T1' }] }],
        { intentos: 1, ultimoError: 'fetch failed', ultimoErrorTipo: 'conexion' },
      )

      await syncRecepcionSession(sesion.id)

      const fila = await filaSesion(sesion.id)
      expect(fila).toMatchObject({ estado: 'sincronizada', ultimoError: null, ultimoErrorTipo: null, intentos: 1 })
      expect(Math.abs((fila.syncedAt as Date).getTime() - Date.now())).toBeLessThan(5_000)
      const auditoria = await db.select().from(auditLog)
      expect(auditoria).toHaveLength(1)
      expect(auditoria[0]).toMatchObject({ accion: 'sync_ok', operarioId: null })
      expect(auditoria[0].detalle).toEqual({ sesionId: sesion.id, odooPickingRef: PICKING_REF })
    })
  })

  describe('what an admin has to fix', () => {
    it('throws ConfiguracionError, without touching Odoo, when the almacén has no reception type', async () => {
      const sinTipo = await seedAlmacen(db, { prefijo: 'IBZ', odooWarehouseId: 2, odooInTypeId: null })
      const sesion = await crearRecepcion([{ courier: dhl, paquetes: [{ tracking: 'T1' }] }], { almacenId: sinTipo.id })

      const error = await syncRecepcionSession(sesion.id).catch((e) => e)

      expect(error).toBeInstanceOf(ConfiguracionError)
      expect(createIncomingPicking).not.toHaveBeenCalled()
      expect(odooCall).not.toHaveBeenCalled()
      expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'confirmada_pendiente_sync', odooPickingId: null })
    })

    it('throws ConfiguracionError, before anything is made in Odoo, when a courier with packages to send has no Odoo product', async () => {
      const sinProducto = await seedCourier(db, { nombre: 'Sin producto', odooProductId: null })
      const sesion = await crearRecepcion([
        { courier: gls, paquetes: [{ tracking: 'T1' }] },
        { courier: sinProducto, paquetes: [{ tracking: 'T2' }] },
      ])

      const error = await syncRecepcionSession(sesion.id).catch((e) => e)

      expect(error).toBeInstanceOf(ConfiguracionError)
      expect(error.message).toContain('Sin producto') // the admin has to know which courier
      // The courier that is fine is not sent either, and no empty picking is left behind.
      expect(createIncomingPicking).not.toHaveBeenCalled()
      expect(addCourierMoveWithLines).not.toHaveBeenCalled()
      expect(odooCall).not.toHaveBeenCalled()
      expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'confirmada_pendiente_sync', odooPickingId: null })
    })
  })

  describe('a message that arrives when the recepción is not waiting for its sync', () => {
    // 'sincronizada': QStash delivered a message whose run already finished. 'en_curso': publishing failed and the
    // recepción went back to the operarios, but the message may have got through. 'error': it failed for good, and
    // Pendientes puts it back to confirmada_pendiente_sync before queuing it again.
    it.each(['sincronizada', 'en_curso', 'error'] as const)('does nothing, in Odoo or here, for a recepción that is %s', async (estado) => {
      const sesion = await crearRecepcion(
        [{ courier: dhl, paquetes: [{ tracking: 'T1' }] }],
        { estado, ultimoError: 'Odoo HTTP 422: no', ultimoErrorTipo: 'odoo', intentos: 3 },
      )
      const antes = await filaSesion(sesion.id)

      await expect(syncRecepcionSession(sesion.id)).resolves.toBeUndefined()

      expect(odooCall).not.toHaveBeenCalled()
      expect(checkDuplicateTrackingNumbers).not.toHaveBeenCalled()
      expect(createIncomingPicking).not.toHaveBeenCalled()
      expect(addCourierMoveWithLines).not.toHaveBeenCalled()
      expect(validatePicking).not.toHaveBeenCalled()
      expect(await filaSesion(sesion.id)).toEqual(antes)
      expect(await paquetes(sesion.id)).toEqual([
        { trackingNumber: 'T1', estado: 'ok', duplicadoAlEnviar: false, duplicadoRef: null },
      ])
      expect(await db.select().from(auditLog)).toEqual([])
    })

    it('does not complain about the configuration either: failing would send the open recepción to error', async () => {
      const sinTipo = await seedAlmacen(db, { prefijo: 'IBZ', odooWarehouseId: 2, odooInTypeId: null })
      const sesion = await crearRecepcion(
        [{ courier: dhl, paquetes: [{ tracking: 'T1' }] }],
        { almacenId: sinTipo.id, estado: 'en_curso' },
      )

      await expect(syncRecepcionSession(sesion.id)).resolves.toBeUndefined()
    })
  })

  it('throws when the recepción does not exist', async () => {
    await expect(syncRecepcionSession('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/no encontrada/)
    expect(odooCall).not.toHaveBeenCalled()
  })
})
