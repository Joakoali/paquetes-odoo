import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('@/lib/queue/publish', () => ({ publishSync: vi.fn() }))
vi.mock('@/lib/audit', () => ({ registrarAuditoria: vi.fn() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  operarioAlmacenes, sesionCourierBatches, sesionItems, sesionesEscaneo,
  type Almacen, type Courier, type Operario,
} from '@/db/schema'
import { registrarAuditoria } from '@/lib/audit'
import { mensajeProblema } from '@/lib/errores'
import { publishSync } from '@/lib/queue/publish'
import { seedAlmacen, seedBarco, seedCourier, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import {
  alcanceDelOperario, contarProblemas, listarProblemas, marcarRevisado, MINUTOS_TRABADO, reintentar,
  type Alcance,
} from './pendientes'

/** The moment the screen is read at in most tests. Everything else is placed relative to it. */
const AHORA = new Date('2026-10-23T12:00:00.000Z')
const haceMinutos = (minutos: number) => new Date(AHORA.getTime() - minutos * 60_000)
/** The same, from the real clock: for the code that reads it itself, like a retry that stamps the moment it happens. */
const haceMinutosReales = (minutos: number) => new Date(Date.now() - minutos * 60_000)

const NO_EXISTE = '00000000-0000-4000-8000-000000000000'

let veronika: Operario
let eduardo: Operario
let mb92: Almacen
let mad1: Almacen
let dhl: Courier
let gls: Courier

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  veronika = await seedOperario(db, { nombre: 'Veronika' })
  eduardo = await seedOperario(db, { nombre: 'Eduardo' })
  mb92 = await seedAlmacen(db)
  mad1 = await seedAlmacen(db, { prefijo: 'MAD1', nombre: 'Madrid (MAD1)', odooWarehouseId: 2, odooInTypeId: 3, odooOutTypeId: 4 })
  dhl = await seedCourier(db)
  gls = await seedCourier(db, { nombre: 'GLS', odooProductId: 12 })
  await seedBarco(db) // 673 MAYANQUEEN
  await seedBarco(db, { odooId: 674, nombre: 'MAYANQUEENIV' })
})

type DatosSesion = Partial<typeof sesionesEscaneo.$inferInsert>

/** A sesión written straight to the database, in any estado. An error one by default, sent an hour ago. */
async function crearSesion(datos: DatosSesion = {}) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: veronika.id,
    almacenId: mb92.id,
    barcoOdooId: 673,
    tipo: 'recepcion',
    estado: 'error',
    confirmedAt: haceMinutos(60),
    ...datos,
  }).returning()
  return sesion
}

/** A send that failed for good. */
const enError = (datos: DatosSesion = {}) =>
  crearSesion({ ultimoErrorTipo: 'odoo', ultimoError: 'Odoo HTTP 422: El lote ya existe', ...datos })

/** A send waiting for its sync since 20 minutes ago: past the 15 that make it stuck. */
const trabada = (datos: DatosSesion = {}) =>
  crearSesion({ estado: 'confirmada_pendiente_sync', confirmedAt: haceMinutos(20), ...datos })

/** A recepción that synced and left a package behind because Odoo already had it when it was sent. */
async function conDuplicado(datos: DatosSesion = {}) {
  const sesion = await crearSesion({ estado: 'sincronizada', ...datos })
  await agregarPaquete(sesion.id, 'JJD-DUP', { estado: 'duplicado', duplicadoAlEnviar: true, duplicadoRef: 'MB92/IN/00198' })
  return sesion
}

/** A package in the courier batch of its sesión. */
async function agregarPaquete(
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

const filaSesion = async (id: string) =>
  (await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, id)))[0]

const idsDe = async (alcance: Alcance, ahora = AHORA) =>
  (await listarProblemas(alcance, ahora)).map((problema) => problema.sesionId)

describe('listarProblemas', () => {
  it('lists errors, stuck sends and sync-time duplicados, only in the operario almacenes', async () => {
    const error = await enError()
    const envioTrabado = await trabada()
    const duplicada = await conDuplicado()
    // The same three in an almacén the operario does not have.
    await enError({ almacenId: mad1.id })
    await trabada({ almacenId: mad1.id })
    await conDuplicado({ almacenId: mad1.id })

    const problemas = await listarProblemas({ almacenIds: [mb92.id] }, AHORA)

    expect(problemas.map((problema) => [problema.tipo, problema.sesionId])).toEqual([
      ['error', error.id],
      ['trabado', envioTrabado.id],
      ['duplicado', duplicada.id],
    ])
  })

  it('admin scope sees every almacén', async () => {
    const deMb92 = await enError()
    const deMad1 = await enError({ almacenId: mad1.id })

    expect(new Set(await idsDe('todos'))).toEqual(new Set([deMb92.id, deMad1.id]))
  })

  it('scan-time duplicados are not problems', async () => {
    // Found while scanning: kept in the recepción, flagged, never sent. The operario saw it on the spot.
    const sesion = await crearSesion({ estado: 'sincronizada' })
    await agregarPaquete(sesion.id, 'JJD-OK', { estado: 'sincronizado' })
    await agregarPaquete(sesion.id, 'JJD-DUP', { estado: 'duplicado', duplicadoAlEnviar: false, duplicadoRef: 'MB92/IN/00198' })

    expect(await idsDe('todos')).toEqual([])
  })

  it('a reviewed session disappears', async () => {
    await enError({ revisadoAt: haceMinutos(5), revisadoPor: eduardo.id })
    await trabada({ revisadoAt: haceMinutos(5), revisadoPor: eduardo.id })
    await conDuplicado({ revisadoAt: haceMinutos(5), revisadoPor: eduardo.id })
    const sinRevisar = await enError()

    expect(await idsDe('todos')).toEqual([sinRevisar.id])
  })

  it('flags configuration errors for the admin', async () => {
    const deConfiguracion = await enError({ ultimoErrorTipo: 'configuracion', ultimoError: 'ODOO_FIELD_RECIBIDO_POR no está configurado' })

    const [problema] = await listarProblemas('todos', AHORA)

    expect(problema.sesionId).toBe(deConfiguracion.id)
    expect(problema.loArreglaElAdmin).toBe(true)
    expect(problema.mensaje).toBe(mensajeProblema('configuracion'))
  })

  describe('what the operario reads for an error', () => {
    it.each([
      ['configuracion', true],
      ['odoo', false],
      ['conexion', false],
    ] as const)('says the message of the %s error, and loArreglaElAdmin is %s', async (tipo, loArreglaElAdmin) => {
      await enError({ ultimoErrorTipo: tipo })

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema.mensaje).toBe(mensajeProblema(tipo))
      expect(problema.loArreglaElAdmin).toBe(loArreglaElAdmin)
    })

    it('reads an error without a type as an error of Odoo', async () => {
      await enError({ ultimoErrorTipo: null })

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema.mensaje).toBe(mensajeProblema('odoo'))
      expect(problema.loArreglaElAdmin).toBe(false)
    })

    it('keeps the technical error for "Ver detalle", and nothing when there is none', async () => {
      await enError({ ultimoError: 'Odoo HTTP 422: El lote ya existe' })
      await enError({ ultimoError: null, barcoOdooId: 674 })

      const detalles = (await listarProblemas('todos', AHORA)).map((problema) => problema.detalle)

      expect(new Set(detalles)).toEqual(new Set(['Odoo HTTP 422: El lote ya existe', null]))
    })
  })

  describe('stuck sends', () => {
    it('is the copy the operario reads', async () => {
      await trabada()

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema.tipo).toBe('trabado')
      expect(problema.mensaje).toBe('Lleva más de 15 minutos enviándose. Probá Reintentar.')
      expect(problema.loArreglaElAdmin).toBe(false)
    })

    it('counts the minutes a send may take from MINUTOS_TRABADO', () => {
      expect(MINUTOS_TRABADO).toBe(15)
    })

    it('does not list a send that has waited for 15 minutes or less', async () => {
      await trabada({ confirmedAt: haceMinutos(1) })
      await trabada({ confirmedAt: haceMinutos(14), barcoOdooId: 674 })
      await trabada({ confirmedAt: haceMinutos(MINUTOS_TRABADO), barcoOdooId: 675 })

      expect(await idsDe('todos')).toEqual([])
    })

    it('lists a send that has waited for a millisecond more than that', async () => {
      const apenasTrabada = await trabada({ confirmedAt: new Date(haceMinutos(MINUTOS_TRABADO).getTime() - 1) })

      expect(await idsDe('todos')).toEqual([apenasTrabada.id])
    })

    it('decides what is stuck by the moment it is asked at', async () => {
      const reciente = await trabada({ confirmedAt: haceMinutos(5) })

      expect(await idsDe('todos', AHORA)).toEqual([])
      expect(await idsDe('todos', new Date(AHORA.getTime() + 11 * 60_000))).toEqual([reciente.id])
    })

    it('reads the clock of the day when no moment is given', async () => {
      await trabada({ confirmedAt: haceMinutosReales(30) })
      await trabada({ confirmedAt: haceMinutosReales(1), barcoOdooId: 674 })

      expect(await listarProblemas('todos')).toHaveLength(1)
      expect(await contarProblemas('todos')).toBe(1)
    })
  })

  describe('duplicados found while sending', () => {
    it('is the copy the operario reads, and says where the package already was', async () => {
      const sesion = await conDuplicado()

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema.sesionId).toBe(sesion.id)
      expect(problema.tipo).toBe('duplicado')
      expect(problema.mensaje).toBe('Estos paquetes ya estaban en Odoo y no se cargaron de nuevo. Revisá que no sea un error.')
      expect(problema.paquetes).toEqual([{ trackingNumber: 'JJD-DUP', ref: 'MB92/IN/00198' }])
    })

    it('lists only the packages that did not go in, whatever else the recepción has', async () => {
      const sesion = await crearSesion({ estado: 'sincronizada' })
      await agregarPaquete(sesion.id, 'JJD-OK', { estado: 'sincronizado' })
      await agregarPaquete(sesion.id, 'JJD-ESCANEO', { estado: 'duplicado', duplicadoAlEnviar: false, duplicadoRef: 'MB92/IN/00001' })
      await agregarPaquete(sesion.id, 'JJD-ENVIO', { estado: 'duplicado', duplicadoAlEnviar: true, duplicadoRef: 'MB92/IN/00002' })

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema.paquetes).toEqual([{ trackingNumber: 'JJD-ENVIO', ref: 'MB92/IN/00002' }])
    })

    it('lists a recepción once however many packages it left behind, in the order they were scanned', async () => {
      const sesion = await crearSesion({ estado: 'sincronizada' })
      const duplicado = (minuto: number) => ({
        estado: 'duplicado' as const, duplicadoAlEnviar: true, createdAt: new Date(`2026-10-23T08:0${minuto}:00.000Z`),
      })
      // Neither the order they were written in nor the alphabetical one is the order they were scanned in.
      await agregarPaquete(sesion.id, 'T-7', { ...duplicado(3), courier: gls, duplicadoRef: 'MB92/IN/00007' })
      await agregarPaquete(sesion.id, 'T-9', { ...duplicado(1), duplicadoRef: 'MB92/IN/00009' })
      await agregarPaquete(sesion.id, 'T-5', { ...duplicado(2), duplicadoRef: null })

      const problemas = await listarProblemas('todos', AHORA)

      expect(problemas).toHaveLength(1)
      expect(problemas[0].paquetes).toEqual([
        { trackingNumber: 'T-9', ref: 'MB92/IN/00009' },
        { trackingNumber: 'T-5', ref: null },
        { trackingNumber: 'T-7', ref: 'MB92/IN/00007' },
      ])
    })

    it('does not list a synced recepción that has nothing flagged, even with a note', async () => {
      const sinNada = await crearSesion({ estado: 'sincronizada', ultimoError: 'Todos los tracking numbers eran duplicados' })
      await agregarPaquete(sinNada.id, 'JJD-OK', { estado: 'sincronizado' })
      await crearSesion({ estado: 'sincronizada', barcoOdooId: 674 }) // empty

      expect(await idsDe('todos')).toEqual([])
    })

    it('lists a recepción that sent nothing at all: every package was a duplicado and there is no picking', async () => {
      const sesion = await conDuplicado({ odooPickingRef: null, ultimoError: 'Todos los tracking numbers eran duplicados' })

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema.sesionId).toBe(sesion.id)
      expect(problema.tipo).toBe('duplicado')
      expect(problema.detalle).toBe('Todos los tracking numbers eran duplicados')
    })
  })

  describe('what each problem says about its sesión', () => {
    it('describes a failed recepción in full', async () => {
      const sesion = await enError({ confirmedAt: haceMinutos(90) })
      await agregarPaquete(sesion.id, 'JJD-1', { createdAt: new Date('2026-10-23T08:00:00.000Z') })
      await agregarPaquete(sesion.id, 'JJD-2', {
        courier: gls, createdAt: new Date('2026-10-23T08:01:00.000Z'), estado: 'duplicado', duplicadoRef: 'MB92/IN/00198',
      })

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema).toEqual({
        sesionId: sesion.id,
        tipo: 'error',
        sesionTipo: 'recepcion',
        almacenPrefijo: 'MB92',
        barcoNombre: 'MAYANQUEEN',
        operarioNombre: 'Veronika',
        fecha: haceMinutos(90),
        // The whole recepción failed, so all of its packages are in it, with where Odoo had the ones it already had.
        paquetes: [
          { trackingNumber: 'JJD-1', ref: null },
          { trackingNumber: 'JJD-2', ref: 'MB92/IN/00198' },
        ],
        mensaje: mensajeProblema('odoo'),
        detalle: 'Odoo HTTP 422: El lote ya existe',
        loArreglaElAdmin: false,
      })
    })

    it('describes a stuck recepción: its packages and no technical detail when there was none', async () => {
      const sesion = await trabada({ operarioId: eduardo.id, almacenId: mad1.id, barcoOdooId: 674 })
      await agregarPaquete(sesion.id, 'JJD-1')

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema).toMatchObject({
        sesionId: sesion.id,
        tipo: 'trabado',
        sesionTipo: 'recepcion',
        almacenPrefijo: 'MAD1',
        barcoNombre: 'MAYANQUEENIV',
        operarioNombre: 'Eduardo',
        fecha: haceMinutos(20),
        paquetes: [{ trackingNumber: 'JJD-1', ref: null }],
        detalle: null,
      })
    })

    it('describes a duplicado by the moment the recepción was sent', async () => {
      await conDuplicado({ confirmedAt: haceMinutos(300) })

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema.fecha).toEqual(haceMinutos(300))
    })

    it('describes an entrega, which has no packages of its own to list', async () => {
      const entrega = await enError({ tipo: 'entrega', operarioId: eduardo.id, ultimoErrorTipo: 'configuracion' })

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema).toMatchObject({
        sesionId: entrega.id, tipo: 'error', sesionTipo: 'entrega', operarioNombre: 'Eduardo', paquetes: [], loArreglaElAdmin: true,
      })
    })

    it('calls a barco the cache does not know by its Odoo id', async () => {
      await enError({ barcoOdooId: 999 })

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema.barcoNombre).toBe('Barco #999')
    })

    it('falls back to when the sesión was created if it was never confirmed', async () => {
      await enError({ confirmedAt: null, createdAt: new Date('2026-10-20T09:00:00.000Z') })

      const [problema] = await listarProblemas('todos', AHORA)

      expect(problema.fecha).toEqual(new Date('2026-10-20T09:00:00.000Z'))
    })
  })

  describe('what is not a problem', () => {
    it('ignores a recepción that is still open, however old and whatever it says', async () => {
      await crearSesion({ estado: 'en_curso', confirmedAt: null, ultimoError: 'something old', ultimoErrorTipo: 'odoo' })

      expect(await idsDe('todos')).toEqual([])
    })

    it('ignores a synced sesión with nothing left behind', async () => {
      await crearSesion({ estado: 'sincronizada' })
      await crearSesion({ estado: 'sincronizada', tipo: 'entrega', barcoOdooId: 674 })

      expect(await idsDe('todos')).toEqual([])
    })

    it('lists nothing for an operario without almacenes', async () => {
      await enError()

      expect(await listarProblemas({ almacenIds: [] }, AHORA)).toEqual([])
    })
  })

  it('lists errors first, then stuck sends, then duplicados, the oldest first in each group', async () => {
    const duplicadoViejo = await conDuplicado({ confirmedAt: haceMinutos(300) })
    const trabadaNueva = await trabada({ confirmedAt: haceMinutos(20) })
    const errorNuevo = await enError({ confirmedAt: haceMinutos(10) })
    const errorViejo = await enError({ confirmedAt: haceMinutos(120) })
    const trabadaVieja = await trabada({ confirmedAt: haceMinutos(90) })
    const duplicadoNuevo = await conDuplicado({ confirmedAt: haceMinutos(60) })

    expect(await idsDe('todos')).toEqual([
      errorViejo.id, errorNuevo.id, trabadaVieja.id, trabadaNueva.id, duplicadoViejo.id, duplicadoNuevo.id,
    ])
  })

  it('breaks a tie between two problems of the same moment by id, so the order never changes between reads', async () => {
    const mismoMomento = haceMinutos(45)
    const a = await enError({ confirmedAt: mismoMomento })
    const b = await enError({ confirmedAt: mismoMomento, barcoOdooId: 674 })
    const c = await enError({ confirmedAt: mismoMomento, barcoOdooId: 675 })

    expect(await idsDe('todos')).toEqual([a.id, b.id, c.id].sort())
  })
})

describe('contarProblemas', () => {
  it('contarProblemas matches listarProblemas', async () => {
    await enError()
    await enError({ almacenId: mad1.id })
    await trabada()
    await trabada({ confirmedAt: haceMinutos(5), barcoOdooId: 674 }) // not stuck yet
    await conDuplicado()
    await conDuplicado({ almacenId: mad1.id })
    await enError({ revisadoAt: haceMinutos(1), revisadoPor: veronika.id, barcoOdooId: 675 }) // reviewed
    await crearSesion({ estado: 'en_curso', barcoOdooId: 676 })

    const alcances: Alcance[] = [
      'todos',
      { almacenIds: [mb92.id] },
      { almacenIds: [mad1.id] },
      { almacenIds: [mb92.id, mad1.id] },
      { almacenIds: [] },
    ]
    for (const alcance of alcances) {
      expect(await contarProblemas(alcance, AHORA)).toBe((await listarProblemas(alcance, AHORA)).length)
    }
    expect(await contarProblemas('todos', AHORA)).toBe(5)
    expect(await contarProblemas({ almacenIds: [mb92.id] }, AHORA)).toBe(3)
    expect(await contarProblemas({ almacenIds: [mad1.id] }, AHORA)).toBe(2)
    expect(await contarProblemas({ almacenIds: [] }, AHORA)).toBe(0)
  })

  it('follows the moment it is asked at, like the list', async () => {
    await trabada({ confirmedAt: haceMinutos(5) })
    const masTarde = new Date(AHORA.getTime() + 11 * 60_000)

    expect(await contarProblemas('todos', AHORA)).toBe(0)
    expect(await contarProblemas('todos', masTarde)).toBe(1)
    expect(await contarProblemas('todos', masTarde)).toBe((await listarProblemas('todos', masTarde)).length)
  })

  it('counts a recepción once however many packages it left behind', async () => {
    const sesion = await conDuplicado()
    await agregarPaquete(sesion.id, 'JJD-DUP-2', { estado: 'duplicado', duplicadoAlEnviar: true, courier: gls })

    expect(await contarProblemas('todos', AHORA)).toBe(1)
  })
})

describe('alcanceDelOperario', () => {
  it('lets the admin see everything', async () => {
    const admin = await seedOperario(db, { rol: 'admin' })

    expect(await alcanceDelOperario(admin)).toBe('todos')
  })

  it('limits an operario to the active almacenes assigned to them', async () => {
    const inactivo = await seedAlmacen(db, { prefijo: 'OLD', nombre: 'Viejo (OLD)', odooWarehouseId: 3, activo: false })
    await seedAlmacen(db, { prefijo: 'OTRO', nombre: 'Otro (OTRO)', odooWarehouseId: 4 }) // not assigned
    await db.insert(operarioAlmacenes).values([
      { operarioId: veronika.id, almacenId: mb92.id },
      { operarioId: veronika.id, almacenId: inactivo.id },
      { operarioId: eduardo.id, almacenId: mad1.id },
    ])

    expect(await alcanceDelOperario(veronika)).toEqual({ almacenIds: [mb92.id] })
  })

  it('gives an operario without almacenes an empty scope, which sees nothing', async () => {
    const alcance = await alcanceDelOperario(veronika)

    expect(alcance).toEqual({ almacenIds: [] })
    await enError()
    expect(await listarProblemas(alcance, AHORA)).toEqual([])
    expect(await contarProblemas(alcance, AHORA)).toBe(0)
  })
})

describe('reintentar', () => {
  it('reintentar puts the session back in the queue and clears revisado', async () => {
    const sesion = await enError({ revisadoAt: haceMinutos(30), revisadoPor: eduardo.id })

    await reintentar({ sesionId: sesion.id, operarioId: veronika.id })

    expect(await filaSesion(sesion.id)).toMatchObject({
      estado: 'confirmada_pendiente_sync', revisadoAt: null, revisadoPor: null,
    })
    expect(publishSync).toHaveBeenCalledTimes(1)
    expect(publishSync).toHaveBeenCalledWith({ sesionId: sesion.id })
  })

  it('audits who retried which sesión', async () => {
    const sesion = await enError({ almacenId: mad1.id, barcoOdooId: 674 })

    await reintentar({ sesionId: sesion.id, operarioId: veronika.id })

    expect(registrarAuditoria).toHaveBeenCalledTimes(1)
    expect(registrarAuditoria).toHaveBeenCalledWith({
      operarioId: veronika.id,
      accion: 'reintento',
      detalle: { sesionId: sesion.id, almacenId: mad1.id, barcoOdooId: 674 },
    })
  })

  it('has the sesión confirmada_pendiente_sync before it is published: the workers ignore any other', async () => {
    const sesion = await enError()
    const estadoAlPublicar: string[] = []
    vi.mocked(publishSync).mockImplementation(async () => {
      estadoAlPublicar.push((await filaSesion(sesion.id)).estado)
    })

    await reintentar({ sesionId: sesion.id, operarioId: veronika.id })

    expect(estadoAlPublicar).toEqual(['confirmada_pendiente_sync'])
  })

  it('audits after publishing, once the retry is really in the queue', async () => {
    const sesion = await enError()

    await reintentar({ sesionId: sesion.id, operarioId: veronika.id })

    expect(vi.mocked(publishSync).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(registrarAuditoria).mock.invocationCallOrder[0])
  })

  it('queues a send that is stuck again', async () => {
    const sesion = await trabada({ revisadoAt: haceMinutos(10), revisadoPor: eduardo.id })

    await reintentar({ sesionId: sesion.id, operarioId: veronika.id })

    expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'confirmada_pendiente_sync', revisadoAt: null, revisadoPor: null })
    expect(publishSync).toHaveBeenCalledWith({ sesionId: sesion.id })
    expect(registrarAuditoria).toHaveBeenCalledWith(expect.objectContaining({ accion: 'reintento' }))
  })

  it('retries an entrega like a recepción', async () => {
    const entrega = await enError({ tipo: 'entrega' })

    await reintentar({ sesionId: entrega.id, operarioId: veronika.id })

    expect(await filaSesion(entrega.id)).toMatchObject({ estado: 'confirmada_pendiente_sync' })
    expect(publishSync).toHaveBeenCalledWith({ sesionId: entrega.id })
  })

  it('leaves the rest of the sesión as it was: the error stays until the sync replaces it', async () => {
    const sesion = await enError({ intentos: 2, ultimoErrorTipo: 'conexion', ultimoError: 'fetch failed', odooPickingRef: 'MB92/IN/00231' })

    await reintentar({ sesionId: sesion.id, operarioId: veronika.id })

    expect(await filaSesion(sesion.id)).toMatchObject({
      intentos: 2, ultimoErrorTipo: 'conexion', ultimoError: 'fetch failed', odooPickingRef: 'MB92/IN/00231',
      almacenId: mb92.id, barcoOdooId: 673, operarioId: veronika.id,
    })
  })

  // The retry stamps the real moment it happens at, so these two are read at the real clock, not at AHORA.
  it('starts the wait of a stuck send again: it is not stuck the moment after it was retried', async () => {
    const vieja = await enError({ confirmedAt: haceMinutosReales(60 * 24 * 20) })
    const trabadaDesdeHace = await trabada({ confirmedAt: haceMinutosReales(20), barcoOdooId: 674 })
    expect(await idsDe('todos', new Date())).toEqual([vieja.id, trabadaDesdeHace.id])

    await reintentar({ sesionId: vieja.id, operarioId: veronika.id })
    await reintentar({ sesionId: trabadaDesdeHace.id, operarioId: veronika.id })

    for (const id of [vieja.id, trabadaDesdeHace.id]) {
      expect(Math.abs((await filaSesion(id)).confirmedAt!.getTime() - Date.now())).toBeLessThan(5_000)
    }
    expect(await idsDe('todos', new Date())).toEqual([])
    // ...and both come back as stuck if they really do not move for 15 minutes (the two were queued within the same few ms).
    const quince = new Date(Date.now() + (MINUTOS_TRABADO + 1) * 60_000)
    expect(new Set(await idsDe('todos', quince))).toEqual(new Set([vieja.id, trabadaDesdeHace.id]))
  })

  it.each(['en_curso', 'sincronizada'] as const)(
    'does nothing for a sesión that is %s: a screen out of date must not queue it',
    async (estado) => {
      const sesion = await crearSesion({
        estado, ultimoError: 'older failure', ultimoErrorTipo: 'odoo', intentos: 1,
        revisadoAt: haceMinutos(30), revisadoPor: eduardo.id,
      })
      const antes = await filaSesion(sesion.id)

      await reintentar({ sesionId: sesion.id, operarioId: veronika.id })

      expect(await filaSesion(sesion.id)).toEqual(antes)
      expect(publishSync).not.toHaveBeenCalled()
      expect(registrarAuditoria).not.toHaveBeenCalled()
    },
  )

  it('does nothing for a sesión that does not exist', async () => {
    await reintentar({ sesionId: NO_EXISTE, operarioId: veronika.id })

    expect(publishSync).not.toHaveBeenCalled()
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('passes on a failure to publish, leaving the sesión waiting and nothing audited', async () => {
    const sesion = await enError()
    vi.mocked(publishSync).mockRejectedValue(new Error('QStash unreachable'))

    await expect(reintentar({ sesionId: sesion.id, operarioId: veronika.id })).rejects.toThrow('QStash unreachable')

    // Waiting for a message that never came: once it has waited long enough, Pendientes shows it as stuck.
    expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'confirmada_pendiente_sync' })
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('touches only the sesión it is asked for', async () => {
    const reintentada = await enError()
    const otra = await enError({ barcoOdooId: 674 })
    const otraAntes = await filaSesion(otra.id)

    await reintentar({ sesionId: reintentada.id, operarioId: veronika.id })

    expect(await filaSesion(otra.id)).toEqual(otraAntes)
    expect(publishSync).toHaveBeenCalledTimes(1)
  })
})

describe('marcarRevisado', () => {
  it('sets who reviewed it and when, and audits it', async () => {
    const sesion = await conDuplicado({ almacenId: mad1.id, barcoOdooId: 674 })
    const antes = Date.now()

    await marcarRevisado({ sesionId: sesion.id, operarioId: eduardo.id })

    const fila = await filaSesion(sesion.id)
    expect(fila.revisadoPor).toBe(eduardo.id)
    expect(fila.revisadoAt!.getTime()).toBeGreaterThanOrEqual(antes)
    expect(fila.revisadoAt!.getTime()).toBeLessThan(antes + 5_000)
    expect(registrarAuditoria).toHaveBeenCalledTimes(1)
    expect(registrarAuditoria).toHaveBeenCalledWith({
      operarioId: eduardo.id,
      accion: 'revisado',
      detalle: { sesionId: sesion.id, almacenId: mad1.id, barcoOdooId: 674 },
    })
  })

  it.each([
    ['an error', () => enError()],
    ['a stuck send', () => trabada()],
    ['a duplicado', () => conDuplicado()],
  ])('makes %s disappear from the list and from the count', async (_tipo, crear) => {
    const sesion = await crear()
    const otra = await enError({ barcoOdooId: 674 })
    expect(await contarProblemas('todos', AHORA)).toBe(2)

    await marcarRevisado({ sesionId: sesion.id, operarioId: veronika.id })

    expect(await idsDe('todos')).toEqual([otra.id])
    expect(await contarProblemas('todos', AHORA)).toBe(1)
  })

  it('does not change the state of the sesión: it is a note, not a fix', async () => {
    const sesion = await enError()

    await marcarRevisado({ sesionId: sesion.id, operarioId: veronika.id })

    expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'error', ultimoError: 'Odoo HTTP 422: El lote ya existe' })
    expect(publishSync).not.toHaveBeenCalled()
  })

  it('keeps who reviewed it first when somebody else, with an old screen, does it again', async () => {
    const sesion = await enError()
    await marcarRevisado({ sesionId: sesion.id, operarioId: veronika.id })
    const despuesDeLaPrimera = await filaSesion(sesion.id)
    vi.mocked(registrarAuditoria).mockClear()

    await marcarRevisado({ sesionId: sesion.id, operarioId: eduardo.id })

    expect(await filaSesion(sesion.id)).toEqual(despuesDeLaPrimera)
    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('does nothing for a sesión that does not exist', async () => {
    await marcarRevisado({ sesionId: NO_EXISTE, operarioId: veronika.id })

    expect(registrarAuditoria).not.toHaveBeenCalled()
  })

  it('touches only the sesión it is asked for', async () => {
    const revisada = await enError()
    const otra = await enError({ barcoOdooId: 674 })

    await marcarRevisado({ sesionId: revisada.id, operarioId: veronika.id })

    expect(await filaSesion(otra.id)).toMatchObject({ revisadoAt: null, revisadoPor: null })
  })

  it('does not stop a retry that fails again from being a problem: retrying clears the review', async () => {
    const sesion = await enError()
    await marcarRevisado({ sesionId: sesion.id, operarioId: veronika.id })
    expect(await idsDe('todos')).toEqual([])

    await reintentar({ sesionId: sesion.id, operarioId: eduardo.id })
    // The worker gives up on it again.
    await db.update(sesionesEscaneo).set({ estado: 'error' }).where(eq(sesionesEscaneo.id, sesion.id))

    expect(await idsDe('todos', new Date())).toEqual([sesion.id])
    // ...and it can be reviewed again, by whoever looks at it now.
    await marcarRevisado({ sesionId: sesion.id, operarioId: eduardo.id })
    expect(await filaSesion(sesion.id)).toMatchObject({ revisadoPor: eduardo.id })
  })
})
