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
