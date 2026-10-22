import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('@/lib/queue/publish', () => ({ publishSync: vi.fn() }))
vi.mock('@/lib/audit', () => ({ registrarAuditoria: vi.fn() }))
// buscarDuplicado stays the real one (it reads tracking_activos_cache); it is a spy only so that a
// test can act in the middle of a scan, which is when two operarios step on each other.
vi.mock('@/lib/cache/trackingActivos', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/cache/trackingActivos')>()
  return { ...real, buscarDuplicado: vi.fn(real.buscarDuplicado) }
})

import { asc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  sesionCourierBatches, sesionItems, sesionesEscaneo, trackingActivosCache,
  type Almacen, type Courier, type Operario,
} from '@/db/schema'
import { registrarAuditoria } from '@/lib/audit'
import { buscarDuplicado } from '@/lib/cache/trackingActivos'
import { publishSync } from '@/lib/queue/publish'
import { seedAlmacen, seedBarco, seedCourier, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import {
  abrirRecepcion, borrarPaquete, contarSinEnviarPorBarco, descartarRecepcion, descartarSiVacia, enviarRecepcion,
  enviarRecepcionesAbiertas, escanearPaquete, EscaneoInvalidoError, getRecepcion, listarEnviadasHoy, listarRecepcionesAbiertas,
  RecepcionCerradaError,
  type PaqueteEscaneado, type ResultadoEscaneo,
} from './recepciones'

const NO_EXISTE = '00000000-0000-4000-8000-000000000000'

let veronika: Operario
let eduardo: Operario
let mb92: Almacen
let dhl: Courier
let gls: Courier

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  veronika = await seedOperario(db, { nombre: 'Veronika' })
  eduardo = await seedOperario(db, { nombre: 'Eduardo' })
  mb92 = await seedAlmacen(db)
  dhl = await seedCourier(db)
  gls = await seedCourier(db, { nombre: 'GLS', odooProductId: 12 })
  await seedBarco(db) // 673 MAYANQUEEN
  await seedBarco(db, { odooId: 674, nombre: 'MAYANQUEENIV' })
})

/** The recepción written straight to the database, for the states the domain functions cannot reach. */
async function crearSesion(datos: Partial<typeof sesionesEscaneo.$inferInsert> = {}) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: veronika.id,
    almacenId: mb92.id,
    barcoOdooId: 673,
    tipo: 'recepcion',
    ...datos,
  }).returning()
  return sesion
}

const filaSesion = async (id: string) =>
  (await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, id)))[0]

/**
 * What is stored for a recepción, one row per package, by tracking number. Not by `createdAt`: PGlite's
 * clock ticks once per millisecond, so packages scanned one after the other often share it.
 */
const guardados = (sesionId: string) =>
  db.select({
    trackingNumber: sesionItems.trackingNumber,
    estado: sesionItems.estado,
    courierId: sesionCourierBatches.courierId,
    operarioId: sesionItems.operarioId,
    duplicadoRef: sesionItems.duplicadoRef,
  })
    .from(sesionItems)
    .innerJoin(sesionCourierBatches, eq(sesionCourierBatches.id, sesionItems.courierBatchId))
    .where(eq(sesionCourierBatches.sesionId, sesionId))
    .orderBy(asc(sesionItems.trackingNumber))

/** The package of a result that has to be an `agregado`. */
function paqueteDe(resultado: ResultadoEscaneo): PaqueteEscaneado {
  if (resultado.tipo !== 'agregado') throw new Error(`Expected agregado, got ${JSON.stringify(resultado)}`)
  return resultado.paquete
}

/** A package written straight to the database, in the courier batch of its recepción. */
async function insertarPaquete(
  sesionId: string,
  trackingNumber: string,
  { courier = dhl, ...datos }: { courier?: Courier } & Partial<typeof sesionItems.$inferInsert> = {},
) {
  const [tanda] = await db.insert(sesionCourierBatches)
    .values({ sesionId, courierId: courier.id })
    .onConflictDoUpdate({ target: [sesionCourierBatches.sesionId, sesionCourierBatches.courierId], set: { sesionId } })
    .returning()
  const [item] = await db.insert(sesionItems)
    .values({ courierBatchId: tanda.id, trackingNumber, operarioId: veronika.id, ...datos })
    .returning()
  return item
}

const abrir = (barcoOdooId = 673, operarioId = veronika.id) =>
  abrirRecepcion({ almacenId: mb92.id, barcoOdooId, operarioId })

const escanear = (
  sesionId: string,
  trackingNumber: string,
  { courier = dhl, operario = veronika }: { courier?: Courier; operario?: Operario } = {},
) => escanearPaquete({ sesionId, courierId: courier.id, trackingNumber, operarioId: operario.id })

describe('abrirRecepcion', () => {
  it('reuses the open recepción of the same almacén and barco, even from another operario', async () => {
    const a = await abrirRecepcion({ almacenId: mb92.id, barcoOdooId: 673, operarioId: veronika.id })
    const b = await abrirRecepcion({ almacenId: mb92.id, barcoOdooId: 673, operarioId: eduardo.id })

    expect(b).toBe(a)
    expect(await db.select().from(sesionesEscaneo)).toHaveLength(1)
  })

  it('opens an en_curso recepción of the almacén and barco, started by the operario', async () => {
    const id = await abrir(673, eduardo.id)

    expect(await filaSesion(id)).toMatchObject({
      almacenId: mb92.id, barcoOdooId: 673, operarioId: eduardo.id, tipo: 'recepcion', estado: 'en_curso', confirmedAt: null,
    })
  })

  // In both tests below the recepción asked for again is the later one, with the higher id: a lookup that
  // ignored the barco or the almacén would hand back the first one it finds, which is the other.
  it('gives each barco its own recepción, and finds the right one among the others', async () => {
    const mayanQueen = await abrir(673)
    const mayanQueenIV = await abrir(674)
    const mayanQueenIVOtraVez = await abrir(674)

    expect(mayanQueenIV).not.toBe(mayanQueen)
    expect(mayanQueenIVOtraVez).toBe(mayanQueenIV)
    expect(await filaSesion(mayanQueenIV)).toMatchObject({ barcoOdooId: 674 })
  })

  it('gives each almacén its own recepción for the same barco, and finds the right one among the others', async () => {
    const mpv = await seedAlmacen(db, { prefijo: 'MPV', nombre: 'Port Vell (MPV)', odooWarehouseId: 2, odooInTypeId: 9, odooOutTypeId: 10 })

    const enMb92 = await abrir(673)
    const enMpv = await abrirRecepcion({ almacenId: mpv.id, barcoOdooId: 673, operarioId: veronika.id })
    const enMpvOtraVez = await abrirRecepcion({ almacenId: mpv.id, barcoOdooId: 673, operarioId: eduardo.id })

    expect(enMpv).not.toBe(enMb92)
    expect(enMpvOtraVez).toBe(enMpv)
    expect(await filaSesion(enMpv)).toMatchObject({ almacenId: mpv.id })
  })

  it('opens a new recepción for a barco whose previous one was already sent', async () => {
    const enviada = await abrir()
    await db.update(sesionesEscaneo).set({ estado: 'confirmada_pendiente_sync' }).where(eq(sesionesEscaneo.id, enviada))

    const nueva = await abrir()
    const otraVez = await abrir() // joins the new one, not the sent one that is older

    expect(nueva).not.toBe(enviada)
    expect(otraVez).toBe(nueva)
    expect(await filaSesion(nueva)).toMatchObject({ estado: 'en_curso' })
  })

  it('does not take an open entrega of the same almacén and barco for its recepción', async () => {
    const entrega = await crearSesion({ tipo: 'entrega' })

    const recepcion = await abrir()
    const otraVez = await abrir() // this one finds the recepción that is already open, with the entrega next to it

    expect(recepcion).not.toBe(entrega.id)
    expect(otraVez).toBe(recepcion)
    expect(await filaSesion(recepcion)).toMatchObject({ tipo: 'recepcion' })
  })

  it('hands the same recepción to two operarios who open the barco at the same time', async () => {
    const [a, b] = await Promise.all([abrir(673, veronika.id), abrir(673, eduardo.id)])

    expect(a).toBe(b)
    expect(await db.select().from(sesionesEscaneo)).toHaveLength(1)
  })
})

describe('escanearPaquete', () => {
  let sesionId: string

  beforeEach(async () => {
    sesionId = await abrir()
  })

  it('adds a package under the chosen courier, creating the courier batch once, and records who scanned it', async () => {
    const primero = await escanear(sesionId, 'JJD1', { operario: veronika })
    const segundo = await escanear(sesionId, 'JJD2', { operario: eduardo })

    expect(primero).toEqual({
      tipo: 'agregado',
      paquete: { id: expect.any(String), trackingNumber: 'JJD1', courierId: dhl.id, courierNombre: 'DHL', estado: 'ok', duplicadoRef: null },
    })
    expect(segundo).toMatchObject({ tipo: 'agregado', paquete: { trackingNumber: 'JJD2' } })
    expect(await db.select().from(sesionCourierBatches)).toMatchObject([{ sesionId, courierId: dhl.id }])
    expect(await guardados(sesionId)).toEqual([
      { trackingNumber: 'JJD1', estado: 'ok', courierId: dhl.id, operarioId: veronika.id, duplicadoRef: null },
      { trackingNumber: 'JJD2', estado: 'ok', courierId: dhl.id, operarioId: eduardo.id, duplicadoRef: null },
    ])
  })

  it('answers with the id the package has in the database, so it can be deleted later', async () => {
    const paquete = paqueteDe(await escanear(sesionId, 'JJD1'))

    const filas = await db.select({ id: sesionItems.id, trackingNumber: sesionItems.trackingNumber }).from(sesionItems)
    expect(filas).toEqual([{ id: paquete.id, trackingNumber: 'JJD1' }])
  })

  it('puts each courier in its own batch and names it in the answer', async () => {
    await escanear(sesionId, 'JJD1', { courier: dhl })
    const deGls = paqueteDe(await escanear(sesionId, 'GLS1', { courier: gls }))

    expect(deGls).toMatchObject({ courierId: gls.id, courierNombre: 'GLS' })
    expect((await db.select().from(sesionCourierBatches)).map((t) => t.courierId).sort()).toEqual([dhl.id, gls.id].sort())
  })

  it('flags a package already in Odoo as duplicado with its reference', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'JJD1', odooPickingId: 9, odooPickingRef: 'MB92/IN/00198' })

    const r = await escanear(sesionId, 'JJD1')

    expect(r).toMatchObject({ tipo: 'agregado', paquete: { estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' } })
    // It is kept, flagged, so the operario sees it and can take it out; it is not what gets sent.
    expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'JJD1', estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' }])
  })

  it('reports a re-scan in the same recepción as repetido and inserts nothing', async () => {
    await escanear(sesionId, 'JJD1')

    expect(await escanear(sesionId, 'JJD1')).toEqual({ tipo: 'repetido', trackingNumber: 'JJD1', donde: 'esta recepción' })
    expect(await guardados(sesionId)).toHaveLength(1)
  })

  it('also takes a re-scan under another courier for the same package', async () => {
    await escanear(sesionId, 'JJD1', { courier: dhl })

    expect(await escanear(sesionId, 'JJD1', { courier: gls })).toEqual({ tipo: 'repetido', trackingNumber: 'JJD1', donde: 'esta recepción' })
    expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'JJD1', courierId: dhl.id }])
    expect(await db.select().from(sesionCourierBatches)).toHaveLength(1) // no empty batch left for GLS
  })

  it('reports a package already in another open recepción as repetido, naming that barco', async () => {
    const otra = await abrir(674) // MAYANQUEENIV
    await escanear(otra, 'XW1')

    const r = await escanear(sesionId, 'XW1')

    expect(r).toEqual({ tipo: 'repetido', trackingNumber: 'XW1', donde: 'la recepción de MAYANQUEENIV' })
    expect(await guardados(sesionId)).toEqual([])
    expect(await guardados(otra)).toHaveLength(1)
    // Nothing at all was created for a repeated code, not even the courier batch.
    expect(await db.select().from(sesionCourierBatches).where(eq(sesionCourierBatches.sesionId, sesionId))).toEqual([])
  })

  it('also counts a recepción that was already sent and is waiting for its sync', async () => {
    const otra = await abrir(674)
    await escanear(otra, 'XW1')
    await db.update(sesionesEscaneo).set({ estado: 'confirmada_pendiente_sync' }).where(eq(sesionesEscaneo.id, otra))

    expect(await escanear(sesionId, 'XW1')).toEqual({ tipo: 'repetido', trackingNumber: 'XW1', donde: 'la recepción de MAYANQUEENIV' })
  })

  it('checks the recepciones of every almacén: a package cannot be in two places', async () => {
    const mpv = await seedAlmacen(db, { prefijo: 'MPV', nombre: 'Port Vell (MPV)', odooWarehouseId: 2, odooInTypeId: 9, odooOutTypeId: 10 })
    const enMpv = await abrirRecepcion({ almacenId: mpv.id, barcoOdooId: 674, operarioId: eduardo.id })
    await escanear(enMpv, 'XW1')

    expect(await escanear(sesionId, 'XW1')).toEqual({ tipo: 'repetido', trackingNumber: 'XW1', donde: 'la recepción de MAYANQUEENIV' })
  })

  it('names the barco by its id when it is not in the cache', async () => {
    const otra = await abrir(999)
    await escanear(otra, 'XW1')

    expect(await escanear(sesionId, 'XW1')).toEqual({ tipo: 'repetido', trackingNumber: 'XW1', donde: 'la recepción de Barco #999' })
  })

  it('does not look in a recepción that already reached Odoo: the Odoo cache is what knows about those', async () => {
    const sincronizada = await abrir(674)
    await escanear(sincronizada, 'XW1')
    await db.update(sesionesEscaneo).set({ estado: 'sincronizada' }).where(eq(sesionesEscaneo.id, sincronizada))

    expect(await escanear(sesionId, 'XW1')).toMatchObject({ tipo: 'agregado', paquete: { estado: 'ok' } })
  })

  it('does not take an entrega for a recepción that already has the code', async () => {
    const entrega = await crearSesion({ tipo: 'entrega', estado: 'confirmada_pendiente_sync', barcoOdooId: 674 })
    await insertarPaquete(entrega.id, 'XW1')

    expect(await escanear(sesionId, 'XW1')).toMatchObject({ tipo: 'agregado', paquete: { trackingNumber: 'XW1', estado: 'ok' } })
  })

  it('tells a code already in this recepción from one in Odoo: repetido wins over duplicado', async () => {
    await escanear(sesionId, 'JJD1')
    await db.insert(trackingActivosCache).values({ trackingNumber: 'JJD1', odooPickingId: 9, odooPickingRef: 'MB92/IN/00198' })

    expect(await escanear(sesionId, 'JJD1')).toEqual({ tipo: 'repetido', trackingNumber: 'JJD1', donde: 'esta recepción' })
  })

  it('trims the code and rejects an empty one', async () => {
    const paquete = paqueteDe(await escanear(sesionId, '  JJD1\n'))

    expect(paquete.trackingNumber).toBe('JJD1')
    await expect(escanear(sesionId, '   ')).rejects.toThrow(EscaneoInvalidoError)
    await expect(escanear(sesionId, '')).rejects.toThrow('El código está vacío.')
    expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'JJD1' }])
  })

  it('stores the code exactly as it was scanned, only trimmed: no case change, no cleaning up', async () => {
    const paquete = paqueteDe(await escanear(sesionId, ' jjd/1-x 2 '))

    expect(paquete.trackingNumber).toBe('jjd/1-x 2')
  })

  it.each(['confirmada_pendiente_sync', 'sincronizada', 'error'] as const)(
    'rejects scanning into a recepción that was already sent (%s)',
    async (estado) => {
      await escanear(sesionId, 'JJD1')
      await db.update(sesionesEscaneo).set({ estado }).where(eq(sesionesEscaneo.id, sesionId))

      await expect(escanear(sesionId, 'JJD2')).rejects.toThrow(RecepcionCerradaError)
      await expect(escanear(sesionId, 'JJD2')).rejects.toThrow('Esta recepción ya se envió a Odoo.')
      expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'JJD1' }])
    },
  )

  it('rejects a recepción that does not exist', async () => {
    const error = await escanear(NO_EXISTE, 'JJD1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EscaneoInvalidoError)
    expect((error as Error).message).toBe('La recepción no existe.')
  })

  it('does not take a code into an entrega', async () => {
    const entrega = await crearSesion({ tipo: 'entrega' })

    await expect(escanear(entrega.id, 'JJD1')).rejects.toThrow('La recepción no existe.')
    expect(await db.select().from(sesionItems)).toEqual([])
  })

  it('checks in order: the empty code, then the closed recepción, then the repeated code', async () => {
    await escanear(sesionId, 'JJD1')
    await db.update(sesionesEscaneo).set({ estado: 'confirmada_pendiente_sync' }).where(eq(sesionesEscaneo.id, sesionId))

    await expect(escanear(NO_EXISTE, ' ')).rejects.toThrow('El código está vacío.') // before the recepción is even looked up
    await expect(escanear(sesionId, 'JJD1')).rejects.toThrow(RecepcionCerradaError) // a closed recepción, though the code is in it
  })

  it('does not ask the Odoo cache about a code it already has', async () => {
    await escanear(sesionId, 'JJD1')
    vi.mocked(buscarDuplicado).mockClear()

    await escanear(sesionId, 'JJD1')

    expect(buscarDuplicado).not.toHaveBeenCalled()
  })

  it('takes both codes when two operarios scan different codes under a new courier at the same time', async () => {
    const [a, b] = await Promise.all([
      escanear(sesionId, 'JJD1', { operario: veronika }),
      escanear(sesionId, 'JJD2', { operario: eduardo }),
    ])

    expect([a.tipo, b.tipo]).toEqual(['agregado', 'agregado'])
    expect(await db.select().from(sesionCourierBatches)).toHaveLength(1)
    expect(await guardados(sesionId)).toHaveLength(2)
  })

  it('keeps a single row when the same code is scanned twice at once: one is agregado, the other repetido', async () => {
    const resultados = await Promise.all([
      escanear(sesionId, 'JJD1', { operario: veronika }),
      escanear(sesionId, 'JJD1', { operario: eduardo }),
    ])

    expect(resultados.map((r) => r.tipo).sort()).toEqual(['agregado', 'repetido'])
    expect(resultados.find((r) => r.tipo === 'repetido')).toEqual({ tipo: 'repetido', trackingNumber: 'JJD1', donde: 'esta recepción' })
    expect(await guardados(sesionId)).toHaveLength(1)
  })

  it('reports repetido when the same code lands in the recepción while this scan is being checked', async () => {
    vi.mocked(buscarDuplicado).mockImplementationOnce(async () => {
      // The other tablet scans the same code right now, between our checks and our insert.
      await escanear(sesionId, 'JJD1', { operario: eduardo })
      return null
    })

    expect(await escanear(sesionId, 'JJD1', { operario: veronika })).toEqual({ tipo: 'repetido', trackingNumber: 'JJD1', donde: 'esta recepción' })
    expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'JJD1', operarioId: eduardo.id }])
  })

  it('refuses the package, and leaves nothing behind, when the recepción is sent while it is being checked', async () => {
    await escanear(sesionId, 'JJD1')
    vi.mocked(buscarDuplicado).mockImplementationOnce(async () => {
      // Someone presses "Enviar" right now. The worker will read the packages from here on:
      // one that went in after that would be shown as added and never reach Odoo.
      await db.update(sesionesEscaneo).set({ estado: 'confirmada_pendiente_sync' }).where(eq(sesionesEscaneo.id, sesionId))
      return null
    })

    await expect(escanear(sesionId, 'JJD2')).rejects.toThrow(RecepcionCerradaError)
    expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'JJD1' }])
  })
})

describe('borrarPaquete', () => {
  let sesionId: string

  beforeEach(async () => {
    sesionId = await abrir()
  })

  it('deletes the package asked for from an open recepción, and only that one', async () => {
    const primero = paqueteDe(await escanear(sesionId, 'JJD1'))
    await escanear(sesionId, 'JJD2', { courier: gls })

    await borrarPaquete(primero.id)

    expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'JJD2' }])
  })

  it('also deletes a duplicado: the ✕ of a red row', async () => {
    await db.insert(trackingActivosCache).values({ trackingNumber: 'JJD1', odooPickingId: 9, odooPickingRef: 'MB92/IN/00198' })
    const duplicado = paqueteDe(await escanear(sesionId, 'JJD1'))

    await borrarPaquete(duplicado.id)

    expect(await guardados(sesionId)).toEqual([])
  })

  it('lets the same code be scanned again once it was deleted', async () => {
    const mal = paqueteDe(await escanear(sesionId, 'JJD1'))
    await borrarPaquete(mal.id)

    expect(await escanear(sesionId, 'JJD1', { courier: gls })).toMatchObject({ tipo: 'agregado', paquete: { courierNombre: 'GLS' } })
  })

  it.each(['confirmada_pendiente_sync', 'sincronizada', 'error'] as const)(
    'refuses once the recepción was sent (%s), and keeps the package',
    async (estado) => {
      const paquete = paqueteDe(await escanear(sesionId, 'JJD1'))
      await db.update(sesionesEscaneo).set({ estado }).where(eq(sesionesEscaneo.id, sesionId))

      await expect(borrarPaquete(paquete.id)).rejects.toThrow(RecepcionCerradaError)
      await expect(borrarPaquete(paquete.id)).rejects.toThrow('Esta recepción ya se envió a Odoo.')
      expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'JJD1' }])
    },
  )

  it('does nothing when the package is already gone: another tablet took it out first', async () => {
    const paquete = paqueteDe(await escanear(sesionId, 'JJD1'))
    await borrarPaquete(paquete.id)

    await expect(borrarPaquete(paquete.id)).resolves.toBeUndefined()
    await expect(borrarPaquete(NO_EXISTE)).resolves.toBeUndefined()
  })
})

describe('descartarRecepcion', () => {
  /** A recepción of the barco with three packages: two DHL (one of them a duplicado) and one GLS. */
  async function recepcionConPaquetes(barcoOdooId = 673) {
    const sesionId = await abrir(barcoOdooId)
    await escanear(sesionId, `A-${barcoOdooId}`, { courier: dhl })
    await escanear(sesionId, `B-${barcoOdooId}`, { courier: dhl })
    await escanear(sesionId, `C-${barcoOdooId}`, { courier: gls })
    await db.update(sesionItems).set({ estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' }).where(eq(sesionItems.trackingNumber, `B-${barcoOdooId}`))
    return sesionId
  }

  it('deletes the packages, the courier batches and the recepción, and audits who did it', async () => {
    const sesionId = await recepcionConPaquetes()

    await descartarRecepcion({ sesionId, operarioId: eduardo.id })

    expect(await db.select().from(sesionesEscaneo)).toEqual([])
    expect(await db.select().from(sesionCourierBatches)).toEqual([])
    expect(await db.select().from(sesionItems)).toEqual([])
    expect(registrarAuditoria).toHaveBeenCalledOnce()
    expect(registrarAuditoria).toHaveBeenCalledWith({
      operarioId: eduardo.id,
      accion: 'recepcion_descartada',
      detalle: { sesionId, almacenId: mb92.id, barcoOdooId: 673, paquetes: 3 },
    })
  })

  it('discards an empty recepción too, and says it had no packages', async () => {
    const sesionId = await abrir()

    await descartarRecepcion({ sesionId, operarioId: veronika.id })

    expect(await db.select().from(sesionesEscaneo)).toEqual([])
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({
      accion: 'recepcion_descartada',
      detalle: expect.objectContaining({ sesionId, paquetes: 0 }),
    }))
  })

  it('leaves every other recepción, with its packages, alone', async () => {
    const descartada = await recepcionConPaquetes(673)
    const otra = await recepcionConPaquetes(674)

    await descartarRecepcion({ sesionId: descartada, operarioId: veronika.id })

    expect((await db.select().from(sesionesEscaneo)).map((s) => s.id)).toEqual([otra])
    expect((await guardados(otra)).map((p) => p.trackingNumber).sort()).toEqual(['A-674', 'B-674', 'C-674'])
    expect(await db.select().from(sesionCourierBatches)).toHaveLength(2)
  })

  it('lets the barco be opened again as a new recepción', async () => {
    const sesionId = await recepcionConPaquetes()
    await descartarRecepcion({ sesionId, operarioId: veronika.id })

    const nueva = await abrir()

    expect(nueva).not.toBe(sesionId)
    expect(await guardados(nueva)).toEqual([])
  })

  it.each(['confirmada_pendiente_sync', 'sincronizada', 'error'] as const)(
    'refuses a recepción that was already sent (%s), leaving it whole and unaudited',
    async (estado) => {
      const sesionId = await recepcionConPaquetes()
      await db.update(sesionesEscaneo).set({ estado }).where(eq(sesionesEscaneo.id, sesionId))

      await expect(descartarRecepcion({ sesionId, operarioId: veronika.id })).rejects.toThrow(RecepcionCerradaError)

      expect(await filaSesion(sesionId)).toMatchObject({ estado })
      expect(await guardados(sesionId)).toHaveLength(3)
      expect(await db.select().from(sesionCourierBatches)).toHaveLength(2)
      expect(registrarAuditoria).not.toHaveBeenCalled()
    },
  )

  it('does nothing, and audits nothing, when the recepción is already gone', async () => {
    await expect(descartarRecepcion({ sesionId: NO_EXISTE, operarioId: veronika.id })).resolves.toBeUndefined()

    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('does not take an entrega for a recepción to discard', async () => {
    const entrega = await crearSesion({ tipo: 'entrega' })

    await descartarRecepcion({ sesionId: entrega.id, operarioId: veronika.id })

    expect(await filaSesion(entrega.id)).toMatchObject({ tipo: 'entrega' })
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('deletes everything in a single db.batch, which is what makes it all-or-nothing on neon-http', async () => {
    const sesionId = await recepcionConPaquetes()
    const batch = vi.spyOn(db as unknown as TestDb, 'batch')

    await descartarRecepcion({ sesionId, operarioId: veronika.id })

    expect(batch).toHaveBeenCalledOnce()
    expect(batch.mock.calls[0][0]).toHaveLength(3) // packages, batches, recepción
  })

  it('leaves a recepción alone when it is sent after it was checked and before it is deleted', async () => {
    const sesionId = await recepcionConPaquetes()
    const testDb = db as unknown as TestDb
    const batchReal = testDb.batch
    vi.spyOn(testDb, 'batch').mockImplementationOnce((async (consultas: PromiseLike<unknown>[]) => {
      // Another tablet presses "Enviar" in the gap. The send wins: the worker is about to read these packages.
      await db.update(sesionesEscaneo).set({ estado: 'confirmada_pendiente_sync' }).where(eq(sesionesEscaneo.id, sesionId))
      return batchReal(consultas as [PromiseLike<unknown>])
    }) as never)

    await expect(descartarRecepcion({ sesionId, operarioId: veronika.id })).rejects.toThrow(RecepcionCerradaError)

    expect(await filaSesion(sesionId)).toMatchObject({ estado: 'confirmada_pendiente_sync' })
    expect(await guardados(sesionId)).toHaveLength(3)
    expect(await db.select().from(sesionCourierBatches)).toHaveLength(2)
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })
})

/** An open recepción of the barco with one DHL package per code. */
async function recepcionCon(barcoOdooId: number, codigos: string[]) {
  const sesionId = await abrir(barcoOdooId)
  for (const codigo of codigos) await escanear(sesionId, codigo)
  return sesionId
}

/** A package that Odoo already has, scanned into the recepción: it goes in as a duplicado. */
async function escanearDuplicado(sesionId: string, codigo: string) {
  await db.insert(trackingActivosCache).values({ trackingNumber: codigo, odooPickingId: 9, odooPickingRef: 'MB92/IN/00198' })
  return paqueteDe(await escanear(sesionId, codigo))
}

const segundosDesde = (fecha: Date) => Math.abs(Date.now() - fecha.getTime()) / 1000

/** A courier batch with no package in it, like the one left behind when its only package is deleted. */
async function tandaVacia(sesionId: string, courier: Courier = dhl) {
  const [tanda] = await db.insert(sesionCourierBatches).values({ sesionId, courierId: courier.id }).returning()
  return tanda
}

/**
 * Runs `durante` once, right before the next `db.batch` (the delete of a discard) starts: what another
 * tablet does after a function has looked at a recepción and before it deletes from it.
 */
function antesDelBatch(durante: () => Promise<unknown>) {
  const testDb = db as unknown as TestDb
  const batchReal = testDb.batch
  vi.spyOn(testDb, 'batch').mockImplementationOnce((async (consultas: PromiseLike<unknown>[]) => {
    await durante()
    return batchReal(consultas as [PromiseLike<unknown>])
  }) as never)
}

describe('descartarSiVacia', () => {
  it('discards a recepción nobody has scanned into, and audits it', async () => {
    const sesionId = await abrir()

    expect(await descartarSiVacia({ sesionId, operarioId: eduardo.id })).toBe(true)

    expect(await db.select().from(sesionesEscaneo)).toEqual([])
    expect(registrarAuditoria).toHaveBeenCalledOnce()
    expect(registrarAuditoria).toHaveBeenCalledWith({
      operarioId: eduardo.id,
      accion: 'recepcion_descartada',
      detalle: { sesionId, almacenId: mb92.id, barcoOdooId: 673, paquetes: 0 },
    })
  })

  it('discards a recepción whose packages were all deleted, together with the empty courier batches they left', async () => {
    const sesionId = await abrir()
    const paquete = paqueteDe(await escanear(sesionId, 'A1'))
    await borrarPaquete(paquete.id)
    await tandaVacia(sesionId, gls)

    expect(await descartarSiVacia({ sesionId, operarioId: eduardo.id })).toBe(true)

    expect(await db.select().from(sesionesEscaneo)).toEqual([])
    expect(await db.select().from(sesionCourierBatches)).toEqual([])
    expect(registrarAuditoria).toHaveBeenCalledOnce()
  })

  it('keeps a recepción that has a package, and says it did not discard it', async () => {
    const sesionId = await recepcionCon(673, ['A1'])

    expect(await descartarSiVacia({ sesionId, operarioId: eduardo.id })).toBe(false)

    expect(await filaSesion(sesionId)).toMatchObject({ estado: 'en_curso' })
    expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'A1', estado: 'ok' }])
    expect(await db.select().from(sesionCourierBatches)).toHaveLength(1)
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('keeps a recepción that has only a duplicado: it is a package somebody has to look at', async () => {
    const sesionId = await abrir()
    await escanearDuplicado(sesionId, 'YA-ESTABA')

    expect(await descartarSiVacia({ sesionId, operarioId: eduardo.id })).toBe(false)

    expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'YA-ESTABA', estado: 'duplicado' }])
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('keeps the packages of a courier batch even when the recepción has another batch that is empty', async () => {
    const sesionId = await recepcionCon(673, ['A1', 'A2'])
    await tandaVacia(sesionId, gls)

    expect(await descartarSiVacia({ sesionId, operarioId: eduardo.id })).toBe(false)

    expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'A1' }, { trackingNumber: 'A2' }])
    expect(await filaSesion(sesionId)).toMatchObject({ estado: 'en_curso' })
  })

  it('keeps a recepción when a scan gets in just before the delete, and so keeps that package', async () => {
    const sesionId = await abrir()
    antesDelBatch(async () => {
      await escanear(sesionId, 'A1', { operario: eduardo })
    })

    expect(await descartarSiVacia({ sesionId, operarioId: veronika.id })).toBe(false)

    expect(await filaSesion(sesionId)).toMatchObject({ estado: 'en_curso' })
    expect(await guardados(sesionId)).toMatchObject([{ trackingNumber: 'A1', operarioId: eduardo.id }])
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it.each(['confirmada_pendiente_sync', 'sincronizada', 'error'] as const)(
    'does not touch a recepción that was already sent (%s), not even its empty courier batch',
    async (estado) => {
      const sesionId = await abrir()
      await tandaVacia(sesionId)
      await db.update(sesionesEscaneo).set({ estado }).where(eq(sesionesEscaneo.id, sesionId))

      expect(await descartarSiVacia({ sesionId, operarioId: eduardo.id })).toBe(false)

      expect(await filaSesion(sesionId)).toMatchObject({ estado })
      expect(await db.select().from(sesionCourierBatches)).toHaveLength(1)
      expect(registrarAuditoria).not.toHaveBeenCalled()
    },
  )

  it('says false, and audits nothing, when the recepción is already gone', async () => {
    expect(await descartarSiVacia({ sesionId: NO_EXISTE, operarioId: eduardo.id })).toBe(false)

    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('never touches an entrega, with or without an empty courier batch', async () => {
    const sinTanda = await crearSesion({ tipo: 'entrega', barcoOdooId: 674 })
    const conTanda = await crearSesion({ tipo: 'entrega', barcoOdooId: 675 })
    await tandaVacia(conTanda.id)

    expect(await descartarSiVacia({ sesionId: sinTanda.id, operarioId: eduardo.id })).toBe(false)
    expect(await descartarSiVacia({ sesionId: conTanda.id, operarioId: eduardo.id })).toBe(false)

    expect((await db.select().from(sesionesEscaneo)).map((s) => s.id).sort()).toEqual([sinTanda.id, conTanda.id].sort())
    expect(await db.select().from(sesionCourierBatches)).toHaveLength(1)
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('discards only the recepción asked for, and not the other empty ones', async () => {
    const descartada = await abrir(673)
    const otra = await abrir(674)
    await tandaVacia(descartada)
    await tandaVacia(otra)

    expect(await descartarSiVacia({ sesionId: descartada, operarioId: eduardo.id })).toBe(true)

    expect((await db.select().from(sesionesEscaneo)).map((s) => s.id)).toEqual([otra])
    expect(await db.select().from(sesionCourierBatches)).toMatchObject([{ sesionId: otra }])
  })
})

describe('enviarRecepcion', () => {
  let sesionId: string

  beforeEach(async () => {
    sesionId = await recepcionCon(673, ['JJD1'])
    await escanear(sesionId, 'GLS1', { courier: gls })
  })

  it('marks it confirmada and publishes it', async () => {
    const resultado = await enviarRecepcion({ sesionId, operarioId: eduardo.id })

    expect(resultado).toBe('enviada')
    const fila = await filaSesion(sesionId)
    expect(fila.estado).toBe('confirmada_pendiente_sync')
    expect(segundosDesde(fila.confirmedAt as Date)).toBeLessThan(5)
    expect(publishSync).toHaveBeenCalledOnce()
    expect(publishSync).toHaveBeenCalledWith({ sesionId })
  })

  it('has it confirmada by the time it is published: the worker can start the moment it is queued', async () => {
    let estadoAlPublicar: string | undefined
    vi.mocked(publishSync).mockImplementationOnce(async () => {
      estadoAlPublicar = (await filaSesion(sesionId)).estado
    })

    await enviarRecepcion({ sesionId, operarioId: eduardo.id })

    expect(estadoAlPublicar).toBe('confirmada_pendiente_sync')
  })

  it('audits the send after publishing it, with who sent it and what went', async () => {
    await escanearDuplicado(sesionId, 'YA-ESTABA')

    await enviarRecepcion({ sesionId, operarioId: eduardo.id })

    expect(registrarAuditoria).toHaveBeenCalledOnce()
    expect(registrarAuditoria).toHaveBeenCalledWith({
      operarioId: eduardo.id,
      accion: 'recepcion_enviada',
      detalle: { sesionId, almacenId: mb92.id, barcoOdooId: 673, paquetes: 2, duplicados: 1 },
    })
    expect(vi.mocked(publishSync).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(registrarAuditoria).mock.invocationCallOrder[0])
  })

  it('sends a recepción that has duplicados along with valid packages, and keeps the duplicados as they are', async () => {
    await escanearDuplicado(sesionId, 'YA-ESTABA')

    expect(await enviarRecepcion({ sesionId, operarioId: eduardo.id })).toBe('enviada')

    expect(await guardados(sesionId)).toMatchObject([
      { trackingNumber: 'GLS1', estado: 'ok' },
      { trackingNumber: 'JJD1', estado: 'ok' },
      { trackingNumber: 'YA-ESTABA', estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' },
    ])
  })

  it('discards an empty recepción instead of sending it', async () => {
    const vacia = await abrir(674)

    expect(await enviarRecepcion({ sesionId: vacia, operarioId: eduardo.id })).toBe('vacia_descartada')

    expect(await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, vacia))).toEqual([])
    expect(publishSync).not.toHaveBeenCalled()
    expect(registrarAuditoria).toHaveBeenCalledOnce()
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({ accion: 'recepcion_descartada' }))
  })

  it('discards a recepción whose packages were all deleted, courier batch included', async () => {
    const vacia = await abrir(674)
    const paquete = paqueteDe(await escanear(vacia, 'A1'))
    await borrarPaquete(paquete.id)

    expect(await enviarRecepcion({ sesionId: vacia, operarioId: eduardo.id })).toBe('vacia_descartada')

    expect(await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, vacia))).toEqual([])
    expect(await db.select().from(sesionCourierBatches).where(eq(sesionCourierBatches.sesionId, vacia))).toEqual([])
    expect(publishSync).not.toHaveBeenCalled()
  })

  it('does not throw away a package that lands after it counted none: it sends the recepción with that package', async () => {
    const vacia = await abrir(674)
    let escaneo: ResultadoEscaneo | undefined
    antesDelBatch(async () => {
      // Another tablet scans a package right now: after "Enviar" found the recepción empty, before it deletes it.
      escaneo = await escanear(vacia, 'A1', { operario: veronika })
    })

    const resultado = await enviarRecepcion({ sesionId: vacia, operarioId: eduardo.id })

    expect(escaneo).toMatchObject({ tipo: 'agregado' }) // the operario was told that it went in...
    expect(resultado).toBe('enviada') // ...so the recepción is not empty any more, and is not 'vacia_descartada'
    expect(await filaSesion(vacia)).toMatchObject({ estado: 'confirmada_pendiente_sync' })
    expect(await guardados(vacia)).toMatchObject([{ trackingNumber: 'A1', operarioId: veronika.id }])
    expect(publishSync).toHaveBeenCalledOnce()
    expect(publishSync).toHaveBeenCalledWith({ sesionId: vacia })
    expect(registrarAuditoria).toHaveBeenCalledOnce()
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({ accion: 'recepcion_enviada' }))
  })

  it('leaves the recepción open, with what landed, when that is a duplicado: there is still nothing to send', async () => {
    const vacia = await abrir(674)
    await db.insert(trackingActivosCache).values({ trackingNumber: 'YA-ESTABA', odooPickingId: 9, odooPickingRef: 'MB92/IN/00198' })
    antesDelBatch(async () => {
      await escanear(vacia, 'YA-ESTABA')
    })

    expect(await enviarRecepcion({ sesionId: vacia, operarioId: eduardo.id })).toBe('sin_paquetes_validos')

    expect(await filaSesion(vacia)).toMatchObject({ estado: 'en_curso' })
    expect(await guardados(vacia)).toMatchObject([{ trackingNumber: 'YA-ESTABA', estado: 'duplicado' }])
    expect(publishSync).not.toHaveBeenCalled()
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('looks again only once: if what landed is gone by then, the recepción is left open and nothing is discarded', async () => {
    const vacia = await abrir(674)
    const testDb = db as unknown as TestDb
    const batchReal = testDb.batch
    vi.spyOn(testDb, 'batch').mockImplementationOnce((async (consultas: PromiseLike<unknown>[]) => {
      const paquete = paqueteDe(await escanear(vacia, 'A1')) // lands before the discard, which so keeps the recepción...
      const resultado = await batchReal(consultas as [PromiseLike<unknown>])
      await borrarPaquete(paquete.id) // ...and is taken out again before "Enviar" looks the second time
      return resultado
    }) as never)

    expect(await enviarRecepcion({ sesionId: vacia, operarioId: eduardo.id })).toBe('sin_paquetes_validos')

    expect(await filaSesion(vacia)).toMatchObject({ estado: 'en_curso' })
    expect(publishSync).not.toHaveBeenCalled()
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('says the recepción does not exist when somebody else discarded it between the count and the discard', async () => {
    const vacia = await abrir(674)
    antesDelBatch(async () => {
      await db.delete(sesionesEscaneo).where(eq(sesionesEscaneo.id, vacia))
    })

    const error = await enviarRecepcion({ sesionId: vacia, operarioId: eduardo.id }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EscaneoInvalidoError)
    expect((error as Error).message).toBe('La recepción no existe.')
    expect(publishSync).not.toHaveBeenCalled()
  })

  it('says it was already sent when somebody else sent it between the count and the discard', async () => {
    const vacia = await abrir(674)
    antesDelBatch(async () => {
      await escanear(vacia, 'A1')
      await db.update(sesionesEscaneo).set({ estado: 'confirmada_pendiente_sync' }).where(eq(sesionesEscaneo.id, vacia))
    })

    await expect(enviarRecepcion({ sesionId: vacia, operarioId: eduardo.id })).rejects.toThrow(RecepcionCerradaError)

    expect(await guardados(vacia)).toMatchObject([{ trackingNumber: 'A1' }])
    expect(publishSync).not.toHaveBeenCalled() // the one who sent it has published it
  })

  it('does not send a recepción with only duplicados, and leaves it open as it was', async () => {
    const soloDuplicados = await abrir(674)
    await escanearDuplicado(soloDuplicados, 'YA-ESTABA')

    expect(await enviarRecepcion({ sesionId: soloDuplicados, operarioId: eduardo.id })).toBe('sin_paquetes_validos')

    expect(await filaSesion(soloDuplicados)).toMatchObject({ estado: 'en_curso', confirmedAt: null })
    expect(await guardados(soloDuplicados)).toMatchObject([{ trackingNumber: 'YA-ESTABA', estado: 'duplicado' }])
    expect(publishSync).not.toHaveBeenCalled()
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('goes back to en_curso when publishing fails, passes the error on, and can be sent again', async () => {
    const fallo = new Error('QStash no responde')
    vi.mocked(publishSync).mockRejectedValueOnce(fallo)

    await expect(enviarRecepcion({ sesionId, operarioId: eduardo.id })).rejects.toBe(fallo)

    expect(await filaSesion(sesionId)).toMatchObject({ estado: 'en_curso', confirmedAt: null })
    expect(await guardados(sesionId)).toHaveLength(2)
    expect(registrarAuditoria).not.toHaveBeenCalled()
    expect(await enviarRecepcion({ sesionId, operarioId: eduardo.id })).toBe('enviada')
  })

  it('still passes the publishing error on when it cannot go back because the barco was opened again meanwhile', async () => {
    const fallo = new Error('QStash no responde')
    vi.mocked(publishSync).mockImplementationOnce(async () => {
      // While QStash fails, the barco is no longer in `en_curso` in the eyes of the unique index,
      // so another operario opens a new recepción for it.
      await abrir(673, eduardo.id)
      throw fallo
    })
    const consola = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(enviarRecepcion({ sesionId, operarioId: eduardo.id })).rejects.toBe(fallo)

      // The original error is what the caller needs; the recepción stays as confirmada, which the
      // "Envío trabado" case of Pendientes picks up so that somebody retries the publishing.
      expect(await filaSesion(sesionId)).toMatchObject({ estado: 'confirmada_pendiente_sync' })
      expect(consola).toHaveBeenCalledOnce()
    } finally {
      consola.mockRestore()
    }
  })

  it('does not reopen a recepción that the worker already took, even if publishing reported a failure', async () => {
    const fallo = new Error('QStash respondió tarde')
    vi.mocked(publishSync).mockImplementationOnce(async () => {
      // The message did reach the queue and the worker was quick: only the answer to us was lost.
      await db.update(sesionesEscaneo).set({ estado: 'sincronizada' }).where(eq(sesionesEscaneo.id, sesionId))
      throw fallo
    })

    await expect(enviarRecepcion({ sesionId, operarioId: eduardo.id })).rejects.toBe(fallo)

    expect(await filaSesion(sesionId)).toMatchObject({ estado: 'sincronizada' })
  })

  it.each(['confirmada_pendiente_sync', 'sincronizada', 'error'] as const)(
    'refuses a recepción that was already sent (%s), without publishing it again',
    async (estado) => {
      await db.update(sesionesEscaneo).set({ estado }).where(eq(sesionesEscaneo.id, sesionId))

      await expect(enviarRecepcion({ sesionId, operarioId: eduardo.id })).rejects.toThrow(RecepcionCerradaError)

      expect(publishSync).not.toHaveBeenCalled()
      expect(registrarAuditoria).not.toHaveBeenCalled()
    },
  )

  it('publishes once when two operarios press Enviar at the same time', async () => {
    const resultados = await Promise.allSettled([
      enviarRecepcion({ sesionId, operarioId: veronika.id }),
      enviarRecepcion({ sesionId, operarioId: eduardo.id }),
    ])

    expect(resultados.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(RecepcionCerradaError)
    expect(publishSync).toHaveBeenCalledOnce()
    expect(registrarAuditoria).toHaveBeenCalledOnce()
  })

  it('rejects a recepción that does not exist', async () => {
    await expect(enviarRecepcion({ sesionId: NO_EXISTE, operarioId: eduardo.id })).rejects.toThrow('La recepción no existe.')
    await expect(enviarRecepcion({ sesionId: NO_EXISTE, operarioId: eduardo.id })).rejects.toThrow(EscaneoInvalidoError)
  })

  it('does not take an entrega for a recepción to send', async () => {
    const entrega = await crearSesion({ tipo: 'entrega' })

    await expect(enviarRecepcion({ sesionId: entrega.id, operarioId: eduardo.id })).rejects.toThrow('La recepción no existe.')
    expect(publishSync).not.toHaveBeenCalled()
  })
})

describe('enviarRecepcionesAbiertas', () => {
  const idsPublicados = () => vi.mocked(publishSync).mock.calls.map(([payload]) => payload.sesionId)

  it('sends every open recepción with valid packages, optionally for one barco', async () => {
    const mayanQueen = await recepcionCon(673, ['A1', 'A2'])
    const mayanQueenIV = await recepcionCon(674, ['B1'])

    // Only the barco asked for.
    expect(await enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id, barcoOdooId: 674 })).toBe(1)
    expect(await filaSesion(mayanQueenIV)).toMatchObject({ estado: 'confirmada_pendiente_sync' })
    expect(await filaSesion(mayanQueen)).toMatchObject({ estado: 'en_curso' })

    // All the rest.
    expect(await enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id })).toBe(1)
    expect(await filaSesion(mayanQueen)).toMatchObject({ estado: 'confirmada_pendiente_sync' })
    expect(idsPublicados()).toEqual([mayanQueenIV, mayanQueen])
  })

  it('leaves in the audit who sent each one', async () => {
    const mayanQueen = await recepcionCon(673, ['A1'])
    const mayanQueenIV = await recepcionCon(674, ['B1'])

    await enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id })

    expect(registrarAuditoria).toHaveBeenCalledTimes(2)
    for (const sesionId of [mayanQueen, mayanQueenIV]) {
      expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({
        operarioId: eduardo.id,
        accion: 'recepcion_enviada',
        detalle: expect.objectContaining({ sesionId }),
      }))
    }
  })

  it('sends them oldest first, so the pickings come out in the order the recepciones were opened', async () => {
    const primera = await recepcionCon(673, ['A1'])
    const segunda = await recepcionCon(674, ['B1'])
    const tercera = await recepcionCon(675, ['C1'])
    // Opened in this order, but with clear gaps: the order must not depend on how fast the test ran.
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T09:00:00Z') }).where(eq(sesionesEscaneo.id, segunda))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T08:00:00Z') }).where(eq(sesionesEscaneo.id, tercera))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T10:00:00Z') }).where(eq(sesionesEscaneo.id, primera))

    await enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id })

    expect(idsPublicados()).toEqual([tercera, segunda, primera])
  })

  it('leaves alone the recepciones that have nothing valid to send, empty ones included', async () => {
    const conPaquetes = await recepcionCon(673, ['A1'])
    const soloDuplicados = await abrir(674)
    await escanearDuplicado(soloDuplicados, 'YA-ESTABA')
    const vacia = await abrir(675) // an operario may be about to scan into it: it must not disappear under their hands

    expect(await enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id })).toBe(1)

    expect(idsPublicados()).toEqual([conPaquetes])
    expect(await filaSesion(soloDuplicados)).toMatchObject({ estado: 'en_curso' })
    expect(await filaSesion(vacia)).toMatchObject({ estado: 'en_curso' })
  })

  it('only sends the recepciones of the almacén asked for', async () => {
    const mpv = await seedAlmacen(db, { prefijo: 'MPV', nombre: 'Port Vell (MPV)', odooWarehouseId: 2, odooInTypeId: 9, odooOutTypeId: 10 })
    const enMb92 = await recepcionCon(673, ['A1'])
    const enMpv = await abrirRecepcion({ almacenId: mpv.id, barcoOdooId: 673, operarioId: veronika.id })
    await escanearPaquete({ sesionId: enMpv, courierId: dhl.id, trackingNumber: 'M1', operarioId: veronika.id })

    expect(await enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id })).toBe(1)

    expect(idsPublicados()).toEqual([enMb92])
    expect(await filaSesion(enMpv)).toMatchObject({ estado: 'en_curso' })
  })

  it('does not send an entrega', async () => {
    const entrega = await crearSesion({ tipo: 'entrega' })
    await insertarPaquete(entrega.id, 'XW1')

    expect(await enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id })).toBe(0)
    expect(publishSync).not.toHaveBeenCalled()
  })

  it('answers 0 and publishes nothing when there is nothing to send', async () => {
    expect(await enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id })).toBe(0)

    expect(publishSync).not.toHaveBeenCalled()
  })

  it('goes on with the rest when one was discarded or sent by somebody else while the others were being sent', async () => {
    const primera = await recepcionCon(673, ['A1'])
    const descartada = await recepcionCon(674, ['B1'])
    const enviadaPorOtro = await recepcionCon(675, ['C1'])
    const ultima = await recepcionCon(676, ['D1'])
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T08:00:00Z') }).where(eq(sesionesEscaneo.id, primera))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T09:00:00Z') }).where(eq(sesionesEscaneo.id, descartada))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T10:00:00Z') }).where(eq(sesionesEscaneo.id, enviadaPorOtro))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T11:00:00Z') }).where(eq(sesionesEscaneo.id, ultima))
    vi.mocked(publishSync).mockImplementationOnce(async () => {
      // While the first one is being published, somebody discards the second and sends the third.
      await descartarRecepcion({ sesionId: descartada, operarioId: veronika.id })
      await db.update(sesionesEscaneo).set({ estado: 'confirmada_pendiente_sync' }).where(eq(sesionesEscaneo.id, enviadaPorOtro))
    })

    expect(await enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id })).toBe(2)

    expect(idsPublicados()).toEqual([primera, ultima])
  })

  it('neither counts nor discards a recepción that has nothing left to send by the time its turn comes', async () => {
    const primera = await recepcionCon(673, ['A1'])
    const sinPaquetes = await recepcionCon(674, ['B1'])
    const soloDuplicados = await recepcionCon(675, ['C1'])
    const ultima = await recepcionCon(676, ['D1'])
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T08:00:00Z') }).where(eq(sesionesEscaneo.id, primera))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T09:00:00Z') }).where(eq(sesionesEscaneo.id, sinPaquetes))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T10:00:00Z') }).where(eq(sesionesEscaneo.id, soloDuplicados))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T11:00:00Z') }).where(eq(sesionesEscaneo.id, ultima))
    vi.mocked(publishSync).mockImplementationOnce(async () => {
      // While the first one is being published, one operario takes every package out of the second
      // and another finds out that the only package of the third was already in Odoo.
      await db.delete(sesionItems).where(eq(sesionItems.trackingNumber, 'B1'))
      await db.update(sesionItems).set({ estado: 'duplicado' }).where(eq(sesionItems.trackingNumber, 'C1'))
    })

    expect(await enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id })).toBe(2)

    expect(idsPublicados()).toEqual([primera, ultima])
    expect(await filaSesion(soloDuplicados)).toMatchObject({ estado: 'en_curso' })
    // The second one was emptied meanwhile. Sending all never discards: it is just not sent, and stays as it is
    // (an operario may be looking at it right now, with their next scan in hand).
    expect(await filaSesion(sinPaquetes)).toMatchObject({ estado: 'en_curso' })
    expect(await db.select().from(sesionCourierBatches).where(eq(sesionCourierBatches.sesionId, sinPaquetes))).toHaveLength(1)
    expect(registrarAuditoria).not.toHaveBeenCalledWith(expect.objectContaining({ accion: 'recepcion_descartada' }))
  })

  it('stops at the first publishing failure: what was sent stays sent, the rest stays open and untouched', async () => {
    const primera = await recepcionCon(673, ['A1'])
    const segunda = await recepcionCon(674, ['B1'])
    const tercera = await recepcionCon(675, ['C1'])
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T08:00:00Z') }).where(eq(sesionesEscaneo.id, primera))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T09:00:00Z') }).where(eq(sesionesEscaneo.id, segunda))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T10:00:00Z') }).where(eq(sesionesEscaneo.id, tercera))
    const fallo = new Error('QStash no responde')
    vi.mocked(publishSync).mockResolvedValueOnce(undefined).mockRejectedValueOnce(fallo)

    await expect(enviarRecepcionesAbiertas({ almacenId: mb92.id, operarioId: eduardo.id })).rejects.toBe(fallo)

    expect(await filaSesion(primera)).toMatchObject({ estado: 'confirmada_pendiente_sync' })
    expect(await filaSesion(segunda)).toMatchObject({ estado: 'en_curso' })
    expect(await filaSesion(tercera)).toMatchObject({ estado: 'en_curso' })
    expect(idsPublicados()).toEqual([primera, segunda])
  })
})

describe('listarRecepcionesAbiertas', () => {
  const amazon = () => seedCourier(db, { nombre: 'Amazon', odooProductId: 13 })

  it('counts packages per courier and skips empty ones', async () => {
    const mayanQueen = await recepcionCon(673, ['A1', 'A2'])
    await escanear(mayanQueen, 'A3', { courier: gls })
    await abrir(674) // an operario opened it and has not scanned anything yet
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T07:12:00Z') }).where(eq(sesionesEscaneo.id, mayanQueen))

    expect(await listarRecepcionesAbiertas(mb92.id)).toEqual([{
      id: mayanQueen,
      barcoOdooId: 673,
      barcoNombre: 'MAYANQUEEN',
      paquetes: 3,
      duplicados: 0,
      porCourier: [{ nombre: 'DHL', cantidad: 2 }, { nombre: 'GLS', cantidad: 1 }],
      abiertaDesde: new Date('2026-10-22T07:12:00Z'),
    }])
  })

  it('orders the couriers of a recepción by how many packages each has, then by name', async () => {
    const sesionId = await recepcionCon(673, ['D1']) // DHL 1
    await escanear(sesionId, 'G1', { courier: gls })
    await escanear(sesionId, 'G2', { courier: gls }) // GLS 2
    await escanear(sesionId, 'Z1', { courier: await amazon() }) // Amazon 1

    const [recepcion] = await listarRecepcionesAbiertas(mb92.id)

    expect(recepcion.porCourier).toEqual([
      { nombre: 'GLS', cantidad: 2 },
      { nombre: 'Amazon', cantidad: 1 },
      { nombre: 'DHL', cantidad: 1 },
    ])
  })

  it('lists them oldest first', async () => {
    const primera = await recepcionCon(673, ['A1'])
    const segunda = await recepcionCon(674, ['B1'])
    const tercera = await recepcionCon(675, ['C1'])
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T09:00:00Z') }).where(eq(sesionesEscaneo.id, primera))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T10:40:00Z') }).where(eq(sesionesEscaneo.id, segunda))
    await db.update(sesionesEscaneo).set({ createdAt: new Date('2026-10-22T08:00:00Z') }).where(eq(sesionesEscaneo.id, tercera))

    expect((await listarRecepcionesAbiertas(mb92.id)).map((r) => r.id)).toEqual([tercera, primera, segunda])
  })

  it('falls back to the barco id when the barco is not in the cache, and keeps the name of an inactive one', async () => {
    await seedBarco(db, { odooId: 700, nombre: 'ARCHIVADO', activo: false })
    await recepcionCon(999, ['A1'])
    await recepcionCon(700, ['B1'])

    const nombres = (await listarRecepcionesAbiertas(mb92.id)).map((r) => [r.barcoOdooId, r.barcoNombre])

    expect(nombres).toEqual(expect.arrayContaining([[999, 'Barco #999'], [700, 'ARCHIVADO']]))
    expect(nombres).toHaveLength(2)
  })

  it('counts only the packages that will be sent, and the duplicados apart', async () => {
    const sesionId = await recepcionCon(673, ['A1', 'A2'])
    await escanearDuplicado(sesionId, 'YA-ESTABA')

    const [recepcion] = await listarRecepcionesAbiertas(mb92.id)

    expect(recepcion).toMatchObject({ id: sesionId, paquetes: 2, duplicados: 1 })
    expect(recepcion.porCourier).toEqual([{ nombre: 'DHL', cantidad: 2 }]) // the duplicado under DHL is not one of its 2
  })

  it('leaves out of porCourier a courier whose packages are all duplicados', async () => {
    const sesionId = await recepcionCon(673, ['A1'])
    await escanearDuplicado(sesionId, 'YA-ESTABA') // scanned under DHL: this helper's courier
    await db.insert(trackingActivosCache).values({ trackingNumber: 'OTRO-YA-ESTABA', odooPickingId: 9, odooPickingRef: 'MB92/IN/00198' })
    await escanear(sesionId, 'OTRO-YA-ESTABA', { courier: gls })

    const [recepcion] = await listarRecepcionesAbiertas(mb92.id)

    expect(recepcion).toMatchObject({ paquetes: 1, duplicados: 2 })
    expect(recepcion.porCourier).toEqual([{ nombre: 'DHL', cantidad: 1 }]) // no "GLS 0"
  })

  it('still lists a recepción that has only duplicados: nothing to send, one duplicado', async () => {
    const soloDuplicados = await abrir(674)
    await escanearDuplicado(soloDuplicados, 'YA-ESTABA')

    expect(await listarRecepcionesAbiertas(mb92.id)).toEqual([{
      id: soloDuplicados,
      barcoOdooId: 674,
      barcoNombre: 'MAYANQUEENIV',
      paquetes: 0,
      duplicados: 1,
      porCourier: [],
      abiertaDesde: expect.any(Date),
    }])
  })

  it('lists only the open recepciones of the almacén asked for', async () => {
    const mpv = await seedAlmacen(db, { prefijo: 'MPV', nombre: 'Port Vell (MPV)', odooWarehouseId: 2, odooInTypeId: 9, odooOutTypeId: 10 })
    const abierta = await recepcionCon(673, ['A1'])
    const enviada = await recepcionCon(674, ['B1'])
    await db.update(sesionesEscaneo).set({ estado: 'confirmada_pendiente_sync' }).where(eq(sesionesEscaneo.id, enviada))
    const enMpv = await abrirRecepcion({ almacenId: mpv.id, barcoOdooId: 675, operarioId: veronika.id })
    await escanearPaquete({ sesionId: enMpv, courierId: dhl.id, trackingNumber: 'M1', operarioId: veronika.id })
    const entrega = await crearSesion({ tipo: 'entrega', barcoOdooId: 676 })
    await insertarPaquete(entrega.id, 'E1')

    expect((await listarRecepcionesAbiertas(mb92.id)).map((r) => r.id)).toEqual([abierta])
    expect((await listarRecepcionesAbiertas(mpv.id)).map((r) => r.id)).toEqual([enMpv])
  })

  it('answers an empty list when nothing is open', async () => {
    expect(await listarRecepcionesAbiertas(mb92.id)).toEqual([])
  })

  it('treats a recepción whose packages were all deleted as empty, though its courier batch is still there', async () => {
    const sesionId = await abrir()
    const paquete = paqueteDe(await escanear(sesionId, 'A1'))
    await borrarPaquete(paquete.id)

    expect(await db.select().from(sesionCourierBatches)).toHaveLength(1)
    expect(await listarRecepcionesAbiertas(mb92.id)).toEqual([])
  })
})

describe('listarEnviadasHoy', () => {
  // 12:00 in Madrid (summer time), so "today" began at 00:00 Madrid time, 22:00 UTC the day before.
  const AHORA = new Date('2026-10-22T10:00:00Z')

  /** A recepción that was sent at `confirmedAt` and has `paquetes` packages (codes `<barco>-1`, `<barco>-2`…). */
  async function enviada(
    barcoOdooId: number,
    confirmedAt: string,
    estado: typeof sesionesEscaneo.$inferInsert['estado'],
    { paquetes = 1, ...datos }: Partial<typeof sesionesEscaneo.$inferInsert> & { paquetes?: number } = {},
  ) {
    const sesion = await crearSesion({ barcoOdooId, estado, confirmedAt: new Date(confirmedAt), ...datos })
    for (let i = 1; i <= paquetes; i++) await insertarPaquete(sesion.id, `${barcoOdooId}-${i}`)
    return sesion
  }

  it('maps estados and only includes today in Madrid time', async () => {
    await seedBarco(db, { odooId: 677, nombre: 'ARCTIC' })
    // Sent today, in the order of the list below: 00:00:00 Madrid, 10:00, 10:30, 11:00 and 11:55.
    const justoHoy = await enviada(677, '2026-10-21T22:00:00Z', 'sincronizada', { odooPickingRef: 'MB92/IN/00230' })
    const ok = await enviada(673, '2026-10-22T08:00:00Z', 'sincronizada', { odooPickingRef: 'MB92/IN/00231', paquetes: 2 })
    const conNota = await enviada(674, '2026-10-22T08:30:00Z', 'sincronizada', {
      odooPickingRef: 'MB92/IN/00232', ultimoError: 'Todos los tracking numbers eran duplicados — no se creó ningún movimiento',
    })
    // `error` alone says it is a problema; ultimoError is only the detail, and may even be missing.
    const conError = await enviada(675, '2026-10-22T09:00:00Z', 'error')
    const enviando = await enviada(676, '2026-10-22T09:55:00Z', 'confirmada_pendiente_sync')
    // Not in the list: one second before today began, still open, another almacén, an entrega.
    await enviada(678, '2026-10-21T21:59:59Z', 'sincronizada')
    await crearSesion({ barcoOdooId: 679, estado: 'en_curso' })
    const mpv = await seedAlmacen(db, { prefijo: 'MPV', nombre: 'Port Vell (MPV)', odooWarehouseId: 2, odooInTypeId: 9, odooOutTypeId: 10 })
    await enviada(680, '2026-10-22T09:00:00Z', 'sincronizada', { almacenId: mpv.id })
    await enviada(681, '2026-10-22T09:00:00Z', 'sincronizada', { tipo: 'entrega' })

    expect(await listarEnviadasHoy(mb92.id, AHORA)).toEqual([
      { id: justoHoy.id, barcoNombre: 'ARCTIC', paquetes: 1, estado: 'ok', odooPickingRef: 'MB92/IN/00230', enviadaAt: new Date('2026-10-21T22:00:00Z') },
      { id: ok.id, barcoNombre: 'MAYANQUEEN', paquetes: 2, estado: 'ok', odooPickingRef: 'MB92/IN/00231', enviadaAt: new Date('2026-10-22T08:00:00Z') },
      { id: conNota.id, barcoNombre: 'MAYANQUEENIV', paquetes: 1, estado: 'problema', odooPickingRef: 'MB92/IN/00232', enviadaAt: new Date('2026-10-22T08:30:00Z') },
      { id: conError.id, barcoNombre: 'Barco #675', paquetes: 1, estado: 'problema', odooPickingRef: null, enviadaAt: new Date('2026-10-22T09:00:00Z') },
      { id: enviando.id, barcoNombre: 'Barco #676', paquetes: 1, estado: 'enviando', odooPickingRef: null, enviadaAt: new Date('2026-10-22T09:55:00Z') },
    ])
  })

  it('counts the packages that went to Odoo: the duplicados of a recepción are left out', async () => {
    const sesion = await enviada(673, '2026-10-22T08:00:00Z', 'sincronizada', { odooPickingRef: 'MB92/IN/00231', paquetes: 3 })
    await db.update(sesionItems).set({ estado: 'sincronizado' }).where(eq(sesionItems.trackingNumber, '673-1'))
    await db.update(sesionItems).set({ estado: 'sincronizado' }).where(eq(sesionItems.trackingNumber, '673-2'))
    await db.update(sesionItems).set({ estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' }).where(eq(sesionItems.trackingNumber, '673-3'))

    expect(await listarEnviadasHoy(mb92.id, AHORA)).toMatchObject([{ id: sesion.id, paquetes: 2, estado: 'ok' }])
  })

  it('counts the packages of a recepción still waiting for its sync, that is, all of them but the duplicados', async () => {
    const sesion = await enviada(673, '2026-10-22T09:55:00Z', 'confirmada_pendiente_sync', { paquetes: 3 })
    await db.update(sesionItems).set({ estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' }).where(eq(sesionItems.trackingNumber, '673-2'))

    expect(await listarEnviadasHoy(mb92.id, AHORA)).toMatchObject([{ id: sesion.id, paquetes: 2, estado: 'enviando' }])
  })

  it('counts the whole day in Madrid time, not in UTC: 23:30 UTC of the day before is already today', async () => {
    // 2026-12-02 10:00 UTC is 11:00 in Madrid (winter time): today began at 23:00 UTC of the day before.
    const ahora = new Date('2026-12-02T10:00:00Z')
    const hoy = await enviada(673, '2026-12-01T23:30:00Z', 'sincronizada')
    await enviada(674, '2026-12-01T22:59:59Z', 'sincronizada')

    expect((await listarEnviadasHoy(mb92.id, ahora)).map((r) => r.id)).toEqual([hoy.id])
  })

  it('takes the moment it is called as "now" when no date is given', async () => {
    const reciente = await enviada(673, '2026-10-22T09:59:00Z', 'confirmada_pendiente_sync')
    await enviada(674, '2026-10-19T09:59:00Z', 'sincronizada') // three days ago
    vi.useFakeTimers({ toFake: ['Date'] }) // only the clock: the database driver still needs its timers
    vi.setSystemTime(AHORA)

    try {
      expect((await listarEnviadasHoy(mb92.id)).map((r) => r.id)).toEqual([reciente.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers an empty list when nothing was sent today', async () => {
    expect(await listarEnviadasHoy(mb92.id, AHORA)).toEqual([])
  })
})

describe('getRecepcion', () => {
  it('returns the recepción with its packages, the newest first', async () => {
    const sesion = await crearSesion()
    await insertarPaquete(sesion.id, 'A1', { createdAt: new Date('2026-10-22T08:00:00Z') })
    await insertarPaquete(sesion.id, 'G1', { courier: gls, createdAt: new Date('2026-10-22T10:00:00Z') })
    await insertarPaquete(sesion.id, 'A2', { createdAt: new Date('2026-10-22T09:00:00Z') })

    const detalle = await getRecepcion(sesion.id)

    expect(detalle).toEqual({
      id: sesion.id,
      almacenId: mb92.id,
      barcoOdooId: 673,
      barcoNombre: 'MAYANQUEEN',
      estado: 'en_curso',
      paquetes: [
        { id: expect.any(String), trackingNumber: 'G1', courierId: gls.id, courierNombre: 'GLS', estado: 'ok', duplicadoRef: null },
        { id: expect.any(String), trackingNumber: 'A2', courierId: dhl.id, courierNombre: 'DHL', estado: 'ok', duplicadoRef: null },
        { id: expect.any(String), trackingNumber: 'A1', courierId: dhl.id, courierNombre: 'DHL', estado: 'ok', duplicadoRef: null },
      ],
    })
  })

  it('gives the packages the ids that borrarPaquete takes, and shows duplicados with where Odoo has them', async () => {
    const sesionId = await abrir()
    await escanear(sesionId, 'JJD1')
    await escanearDuplicado(sesionId, 'YA-ESTABA')

    const detalle = await getRecepcion(sesionId)
    const duplicado = detalle?.paquetes.find((p) => p.trackingNumber === 'YA-ESTABA')
    expect(duplicado).toMatchObject({ estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' })
    await borrarPaquete((duplicado as PaqueteEscaneado).id)

    expect((await getRecepcion(sesionId))?.paquetes.map((p) => p.trackingNumber)).toEqual(['JJD1'])
  })

  it('returns an empty recepción with no packages', async () => {
    const sesionId = await abrir()

    expect(await getRecepcion(sesionId)).toMatchObject({ id: sesionId, estado: 'en_curso', paquetes: [] })
  })

  it('keeps returning a recepción once it was sent, with its estado, so the screen can say so', async () => {
    const sesion = await crearSesion({ estado: 'sincronizada' })
    await insertarPaquete(sesion.id, 'A1', { estado: 'sincronizado' })
    await insertarPaquete(sesion.id, 'A2', { estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' })

    const detalle = await getRecepcion(sesion.id)

    expect(detalle?.estado).toBe('sincronizada')
    // Whatever is not a duplicado is a package that counts, whether it already went to Odoo or not.
    expect(detalle?.paquetes.map((p) => [p.trackingNumber, p.estado]).sort()).toEqual([['A1', 'ok'], ['A2', 'duplicado']])
  })

  it('names a barco that is not in the cache by its id', async () => {
    const sesion = await crearSesion({ barcoOdooId: 999 })

    expect(await getRecepcion(sesion.id)).toMatchObject({ barcoOdooId: 999, barcoNombre: 'Barco #999' })
  })

  it('returns null for a recepción that does not exist, for an entrega, and for something that is not an id', async () => {
    const entrega = await crearSesion({ tipo: 'entrega' })

    expect(await getRecepcion(NO_EXISTE)).toBeNull()
    expect(await getRecepcion(entrega.id)).toBeNull()
    // It comes from the address bar: Postgres would throw on it instead of finding nothing.
    expect(await getRecepcion('no-es-un-id')).toBeNull()
  })
})

describe('contarSinEnviarPorBarco', () => {
  it('counts valid packages of open recepciones per barco', async () => {
    await recepcionCon(673, ['A1', 'A2', 'A3'])
    const conDuplicado = await recepcionCon(674, ['B1'])
    await escanearDuplicado(conDuplicado, 'YA-ESTABA') // not valid: it is not going to be sent
    const soloDuplicados = await abrir(675)
    await escanearDuplicado(soloDuplicados, 'OTRO-YA-ESTABA')
    await abrir(676) // empty
    const enviada = await recepcionCon(677, ['S1', 'S2'])
    await db.update(sesionesEscaneo).set({ estado: 'confirmada_pendiente_sync' }).where(eq(sesionesEscaneo.id, enviada))
    const mpv = await seedAlmacen(db, { prefijo: 'MPV', nombre: 'Port Vell (MPV)', odooWarehouseId: 2, odooInTypeId: 9, odooOutTypeId: 10 })
    const enMpv = await abrirRecepcion({ almacenId: mpv.id, barcoOdooId: 673, operarioId: veronika.id })
    await escanearPaquete({ sesionId: enMpv, courierId: dhl.id, trackingNumber: 'M1', operarioId: veronika.id })
    const entrega = await crearSesion({ tipo: 'entrega', barcoOdooId: 678 })
    await insertarPaquete(entrega.id, 'E1')

    const cuentas = await contarSinEnviarPorBarco(mb92.id)

    expect(cuentas).toBeInstanceOf(Map)
    expect([...cuentas.entries()].sort()).toEqual([[673, 3], [674, 1]])
  })

  it('adds up the packages of every courier of the barco', async () => {
    const sesionId = await recepcionCon(673, ['A1', 'A2'])
    await escanear(sesionId, 'G1', { courier: gls })

    expect((await contarSinEnviarPorBarco(mb92.id)).get(673)).toBe(3)
  })

  it('answers an empty map when there is nothing to send', async () => {
    expect((await contarSinEnviarPorBarco(mb92.id)).size).toBe(0)
  })
})
