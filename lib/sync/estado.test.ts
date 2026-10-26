import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog, sesionesEscaneo, type Almacen, type Operario } from '@/db/schema'
import { ConfiguracionError, OdooError } from '@/lib/errores'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { registrarFalloSync } from './estado'

let operario: Operario
let almacen: Almacen

beforeEach(async () => {
  await resetTestDb(db as unknown as TestDb)
  operario = await seedOperario(db)
  almacen = await seedAlmacen(db)
})

/** A recepción that was confirmed and is waiting for its sync, unless `datos` say otherwise. */
async function seedSesion(datos: Partial<typeof sesionesEscaneo.$inferInsert> = {}) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: operario.id,
    almacenId: almacen.id,
    barcoOdooId: 673,
    tipo: 'recepcion',
    estado: 'confirmada_pendiente_sync',
    ...datos,
  }).returning()
  return sesion
}

const estadoDe = async (id: string) =>
  (await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, id)))[0]

describe('registrarFalloSync', () => {
  it.each([0, 1])(
    'a connection failure with reintentosHechos %i keeps the session pending and is not final',
    async (reintentosHechos) => {
      const s = await seedSesion()

      const r = await registrarFalloSync({ sesionId: s.id, error: new TypeError('fetch failed'), reintentosHechos })

      expect(r).toEqual({ final: false, tipo: 'conexion' })
      expect(await estadoDe(s.id)).toMatchObject({
        estado: 'confirmada_pendiente_sync',
        intentos: 1,
        ultimoError: 'fetch failed',
        ultimoErrorTipo: 'conexion',
      })
    },
  )

  it.each([2, 3])('a connection failure with reintentosHechos %i marks the session in error', async (reintentosHechos) => {
    const s = await seedSesion()

    const r = await registrarFalloSync({ sesionId: s.id, error: new TypeError('fetch failed'), reintentosHechos })

    expect(r).toEqual({ final: true, tipo: 'conexion' })
    expect(await estadoDe(s.id)).toMatchObject({ estado: 'error', intentos: 1, ultimoErrorTipo: 'conexion' })
  })

  it('a configuration error is final on the first attempt', async () => {
    const s = await seedSesion()

    const r = await registrarFalloSync({
      sesionId: s.id,
      error: new ConfiguracionError('Falta ODOO_FIELD_RECIBIDO_POR'),
      reintentosHechos: 0,
    })

    expect(r).toEqual({ final: true, tipo: 'configuracion' })
    expect(await estadoDe(s.id)).toMatchObject({ estado: 'error', ultimoErrorTipo: 'configuracion' })
  })

  it.each([401, 403])('an Odoo %i is a matter of configuration for the admin, and final on the first attempt', async (status) => {
    const s = await seedSesion()

    const r = await registrarFalloSync({
      sesionId: s.id,
      error: new OdooError({ status, data: { name: 'odoo.exceptions.AccessError', message: 'No tenés acceso' } }),
      reintentosHechos: 0,
    })

    expect(r).toEqual({ final: true, tipo: 'configuracion' })
    expect(await estadoDe(s.id)).toMatchObject({ estado: 'error', ultimoErrorTipo: 'configuracion' })
  })

  it('an Odoo rejection is final on the first attempt', async () => {
    const s = await seedSesion()
    const error = new OdooError({ status: 422, data: { name: 'odoo.exceptions.ValidationError', message: 'x' } })

    const r = await registrarFalloSync({ sesionId: s.id, error, reintentosHechos: 0 })

    expect(r).toEqual({ final: true, tipo: 'odoo' })
    expect(await estadoDe(s.id)).toMatchObject({ estado: 'error', ultimoErrorTipo: 'odoo' })
  })

  // An OdooError says its HTTP status (its own message no longer does); anything else is its message.
  const mensajes: Array<[string, unknown, string]> = [
    [
      'an OdooError Odoo answered',
      new OdooError({ status: 422, data: { name: 'odoo.exceptions.ValidationError', message: 'El lote ya existe' } }),
      'Odoo HTTP 422: El lote ya existe',
    ],
    [
      'an OdooError from a gateway, which has no message of its own',
      new OdooError({ status: 502, data: null }),
      'Odoo HTTP 502: Odoo call failed: null',
    ],
    ['a ConfiguracionError', new ConfiguracionError('Falta ODOO_FIELD_RECIBIDO_POR'), 'Falta ODOO_FIELD_RECIBIDO_POR'],
    ['a network TypeError', new TypeError('fetch failed'), 'fetch failed'],
    ['a thrown string', 'boom', 'boom'],
  ]
  it.each(mensajes)('stores %s as ultimoError', async (_caso, error, ultimoError) => {
    const s = await seedSesion()

    await registrarFalloSync({ sesionId: s.id, error, reintentosHechos: 0 })

    expect((await estadoDe(s.id)).ultimoError).toBe(ultimoError)
  })

  it('counts every failure and keeps the last error and its type', async () => {
    const s = await seedSesion()

    await registrarFalloSync({ sesionId: s.id, error: new TypeError('fetch failed'), reintentosHechos: 0 })
    await registrarFalloSync({ sesionId: s.id, error: new Error('picking 5 no existe en Odoo'), reintentosHechos: 1 })

    expect(await estadoDe(s.id)).toMatchObject({
      estado: 'error',
      intentos: 2,
      ultimoError: 'picking 5 no existe en Odoo',
      ultimoErrorTipo: 'odoo',
    })
  })

  it('leaves the state alone when the failure is not final, even if it is already error', async () => {
    // A send the operario retried by hand: it is in error until it works.
    const s = await seedSesion({ estado: 'error', intentos: 3 })

    const r = await registrarFalloSync({ sesionId: s.id, error: new TypeError('fetch failed'), reintentosHechos: 0 })

    expect(r.final).toBe(false)
    expect(await estadoDe(s.id)).toMatchObject({ estado: 'error', intentos: 4 })
  })

  it('only touches the session that failed', async () => {
    const fallida = await seedSesion()
    const otra = await seedSesion({ barcoOdooId: 674 })

    await registrarFalloSync({ sesionId: fallida.id, error: new Error('x'), reintentosHechos: 0 })

    expect(await estadoDe(otra.id)).toMatchObject({
      estado: 'confirmada_pendiente_sync',
      intentos: 0,
      ultimoError: null,
      ultimoErrorTipo: null,
    })
  })

  // Somebody can mark a send that looks stuck as reviewed in Pendientes, and it then stops being listed. If it
  // later fails for good that is a new problem which nobody has seen, and it has to be listed again.
  describe('a session somebody marked as reviewed', () => {
    const REVISADA = { revisadoAt: new Date('2026-10-23T10:00:00.000Z') }

    const FINALES: Array<[caso: string, error: unknown, reintentosHechos: number]> = [
      ['a configuration error', new ConfiguracionError('Falta ODOO_FIELD_RECIBIDO_POR'), 0],
      ['an Odoo rejection', new OdooError({ status: 422, data: { name: 'odoo.exceptions.ValidationError', message: 'x' } }), 0],
      ['a connection failure that used up its retries', new TypeError('fetch failed'), 2],
    ]
    it.each(FINALES)('is not reviewed any more after %s, which is final', async (_caso, error, reintentosHechos) => {
      const s = await seedSesion({ ...REVISADA, revisadoPor: operario.id })

      const r = await registrarFalloSync({ sesionId: s.id, error, reintentosHechos })

      expect(r.final).toBe(true)
      expect(await estadoDe(s.id)).toMatchObject({ estado: 'error', revisadoAt: null, revisadoPor: null })
    })

    it.each([0, 1])('stays reviewed after a failure that is not final (reintentosHechos %i)', async (reintentosHechos) => {
      const s = await seedSesion({ ...REVISADA, revisadoPor: operario.id })

      const r = await registrarFalloSync({ sesionId: s.id, error: new TypeError('fetch failed'), reintentosHechos })

      expect(r.final).toBe(false)
      expect(await estadoDe(s.id)).toMatchObject({
        estado: 'confirmada_pendiente_sync', intentos: 1, ...REVISADA, revisadoPor: operario.id,
      })
    })

    it('leaves the review of every other session alone', async () => {
      const fallida = await seedSesion({ ...REVISADA, revisadoPor: operario.id })
      const otra = await seedSesion({ ...REVISADA, revisadoPor: operario.id, estado: 'error', barcoOdooId: 674 })

      await registrarFalloSync({ sesionId: fallida.id, error: new Error('x'), reintentosHechos: 0 })

      expect(await estadoDe(otra.id)).toMatchObject({ ...REVISADA, revisadoPor: operario.id })
    })

    it('still gets its error recorded, as for any other session', async () => {
      const s = await seedSesion({ ...REVISADA, revisadoPor: operario.id })

      await registrarFalloSync({ sesionId: s.id, error: new ConfiguracionError('Falta X'), reintentosHechos: 0 })

      expect(await estadoDe(s.id)).toMatchObject({ intentos: 1, ultimoError: 'Falta X', ultimoErrorTipo: 'configuracion' })
    })
  })

  it('has nothing to clear on a session that was never reviewed', async () => {
    const s = await seedSesion()

    await registrarFalloSync({ sesionId: s.id, error: new Error('x'), reintentosHechos: 0 })

    expect(await estadoDe(s.id)).toMatchObject({ estado: 'error', revisadoAt: null, revisadoPor: null })
  })

  it('audits every failure as sync_error, with no operario, saying whether it was final', async () => {
    const s = await seedSesion()

    await registrarFalloSync({ sesionId: s.id, error: new TypeError('fetch failed'), reintentosHechos: 0 })
    await registrarFalloSync({ sesionId: s.id, error: new TypeError('fetch failed'), reintentosHechos: 2 })

    const filas = await db.select().from(auditLog)
    expect(filas).toHaveLength(2)
    expect(filas.every((f) => f.accion === 'sync_error' && f.operarioId === null)).toBe(true)
    expect(filas.map((f) => f.detalle)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sesionId: s.id, tipo: 'conexion', final: false, error: 'fetch failed' }),
      expect.objectContaining({ sesionId: s.id, tipo: 'conexion', final: true, error: 'fetch failed' }),
    ]))
  })
})
