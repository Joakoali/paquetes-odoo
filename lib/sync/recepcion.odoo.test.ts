import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Unlike recepcion.test.ts, nothing of lib/odoo/pickings is replaced here: only the HTTP call is, by a small
// Odoo that remembers what is made in it. What is under test is what a retry leaves behind in Odoo, and for
// that the worker and the module that talks to Odoo have to run together.
vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('@/lib/odoo/client', () => ({ odooCall: vi.fn() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  sesionCourierBatches, sesionItems, sesionesEscaneo, trackingActivosCache,
  type Almacen, type Courier, type Operario,
} from '@/db/schema'
import { clasificarError, OdooError, RespuestaOdooInesperadaError } from '@/lib/errores'
import { odooCall } from '@/lib/odoo/client'
import { seedAlmacen, seedCourier, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { registrarFalloSync } from './estado'
import { syncRecepcionSession } from './recepcion'

const PICKING_REF = 'MB92/IN/00231'

interface Movimiento { id: number; picking_id: number; product_id: number; product_uom_qty: number; state: string }
interface Linea { id: number; move_id: number; picking_id: number; lot_name: string }

/** What the Odoo of the test has, and what it is told to do wrong. */
const odoo = {
  pickingId: 0,
  estadoDelPicking: 'draft',
  /** What `button_validate` answers: `true` when it validated, an action when it wants something confirmed. */
  respuestaDeValidar: true as unknown,
  movimientos: [] as Movimiento[],
  lineas: [] as Linea[],
  siguienteId: 1000,
  /**
   * A call that fails once. `despues: true` is a timeout that came after Odoo had done the work, which is what a
   * dropped connection looks like from here: the work is there and the answer never arrived.
   */
  fallo: null as null | { modelo: string; metodo: string; despues: boolean },
}

const sinRespuesta = () => new OdooError({ status: 504, data: 'Gateway Timeout' })

function coincide(fila: Record<string, unknown>, dominio: unknown[]): boolean {
  return dominio.every((condicion) => {
    const [campo, operador, valor] = condicion as [string, string, unknown]
    if (campo.includes('.')) return false // `lot_id.name`: this Odoo has no lots until a picking is validated
    if (operador === '=') return fila[campo] === valor
    if (operador === '!=') return fila[campo] !== valor
    throw new Error(`operador ${operador} no previsto en este Odoo de prueba`)
  })
}

function odooResponde(modelo: string, metodo: string, params: Record<string, unknown>): unknown {
  const { fallo } = odoo
  const falla = fallo !== null && fallo.modelo === modelo && fallo.metodo === metodo
  if (falla && !fallo.despues) {
    odoo.fallo = null
    throw sinRespuesta()
  }
  const resultado = ejecuta(modelo, metodo, params)
  if (falla) {
    odoo.fallo = null
    throw sinRespuesta()
  }
  return resultado
}

function ejecuta(modelo: string, metodo: string, params: Record<string, unknown>): unknown {
  const filas = (params.vals_list ?? []) as Array<Record<string, unknown>>
  if (modelo === 'stock.picking') {
    if (metodo === 'create') {
      odoo.pickingId = odoo.siguienteId++
      return [odoo.pickingId]
    }
    if (metodo === 'read') {
      const campos: Record<string, unknown> = {
        id: odoo.pickingId, name: PICKING_REF, state: odoo.estadoDelPicking,
        location_id: [1, 'Partners/Vendors'], location_dest_id: [5, 'MB92/Stock'],
      }
      return [Object.fromEntries(['id', ...(params.fields as string[])].map((campo) => [campo, campos[campo]]))]
    }
    if (metodo === 'button_validate') {
      if (odoo.respuestaDeValidar === true) odoo.estadoDelPicking = 'done'
      return odoo.respuestaDeValidar
    }
    return true // action_confirm, action_assign, message_post, write
  }
  if (modelo === 'stock.move') {
    if (metodo === 'create') {
      return filas.map((fila) => {
        const id = odoo.siguienteId++
        odoo.movimientos.push({
          id, picking_id: fila.picking_id as number, product_id: fila.product_id as number,
          product_uom_qty: fila.product_uom_qty as number, state: 'draft',
        })
        return id
      })
    }
    if (metodo === 'search_read') {
      return odoo.movimientos.filter((m) => coincide(m as unknown as Record<string, unknown>, params.domain as unknown[]))
    }
  }
  if (modelo === 'stock.move.line') {
    if (metodo === 'create') {
      return filas.map((fila) => {
        const id = odoo.siguienteId++
        odoo.lineas.push({
          id, move_id: fila.move_id as number, picking_id: fila.picking_id as number, lot_name: fila.lot_name as string,
        })
        return id
      })
    }
    if (metodo === 'search_read') {
      return odoo.lineas
        .filter((l) => coincide(l as unknown as Record<string, unknown>, params.domain as unknown[]))
        .map((l) => ({ id: l.id, move_id: [l.move_id, 'move'], lot_name: l.lot_name, lot_id: false }))
    }
  }
  throw new Error(`${modelo}.${metodo} no previsto en este Odoo de prueba`)
}

let veronika: Operario
let almacen: Almacen
let dhl: Courier

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  Object.assign(odoo, {
    pickingId: 0, estadoDelPicking: 'draft', respuestaDeValidar: true,
    movimientos: [], lineas: [], siguienteId: 1000, fallo: null,
  })
  vi.stubEnv('ODOO_FIELD_BARCO', 'x_studio_barco')
  vi.stubEnv('ODOO_FIELD_RECIBIDO_POR', 'x_studio_recibido_por_2')
  vi.mocked(odooCall).mockImplementation(async (modelo, metodo, params) => odooResponde(modelo, metodo, params ?? {}) as never)

  veronika = await seedOperario(db, { nombre: 'Veronika' })
  almacen = await seedAlmacen(db)
  dhl = await seedCourier(db)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** A recepción waiting for its sync, with DHL's packages. */
async function crearRecepcion(trackings: string[]) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: veronika.id, almacenId: almacen.id, barcoOdooId: 673,
    tipo: 'recepcion', estado: 'confirmada_pendiente_sync',
  }).returning()
  const [tanda] = await db.insert(sesionCourierBatches).values({ sesionId: sesion.id, courierId: dhl.id }).returning()
  for (const [i, trackingNumber] of trackings.entries()) {
    await db.insert(sesionItems).values({
      courierBatchId: tanda.id, trackingNumber, operarioId: veronika.id,
      createdAt: new Date(Date.UTC(2026, 9, 22, 8, 0, i)),
    })
  }
  return sesion
}

const filaSesion = async (id: string) =>
  (await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, id)))[0]

const lotsDeLaLinea = () => odoo.lineas.map((l) => l.lot_name).sort()

/** What QStash and the route do with a sync that threw: note it, and say whether a retry may follow. */
const falla = (sesionId: string, error: unknown, reintentosHechos = 0) =>
  registrarFalloSync({ sesionId, error, reintentosHechos })

describe('a retry after the lines of a move failed to arrive', () => {
  it('leaves exactly one move, with all its lines, when the call that creates the lines failed', async () => {
    const sesion = await crearRecepcion(['T1', 'T2'])
    odoo.fallo = { modelo: 'stock.move.line', metodo: 'create', despues: false }

    const error = await syncRecepcionSession(sesion.id).catch((e) => e)
    expect(error).toBeInstanceOf(OdooError)
    expect((await falla(sesion.id, error)).final).toBe(false) // a gateway timeout: QStash retries it
    expect(odoo.movimientos).toHaveLength(1) // the move is there, still without its lines
    expect(odoo.lineas).toHaveLength(0)

    await syncRecepcionSession(sesion.id)

    expect(odoo.movimientos).toHaveLength(1)
    expect(odoo.movimientos[0]).toMatchObject({ picking_id: odoo.pickingId, product_id: 11, product_uom_qty: 2 })
    expect(lotsDeLaLinea()).toEqual(['T1', 'T2'])
    expect(odoo.lineas.every((l) => l.move_id === odoo.movimientos[0].id)).toBe(true)
    expect(odoo.estadoDelPicking).toBe('done')
    expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'sincronizada', ultimoError: null, ultimoErrorTipo: null })
  })

  it('does not create the lines twice when the call that creates them answered too late but did create them', async () => {
    const sesion = await crearRecepcion(['T1', 'T2'])
    odoo.fallo = { modelo: 'stock.move.line', metodo: 'create', despues: true }

    await expect(syncRecepcionSession(sesion.id)).rejects.toBeInstanceOf(OdooError)
    expect(odoo.lineas).toHaveLength(2)

    await syncRecepcionSession(sesion.id)

    expect(odoo.movimientos).toHaveLength(1)
    expect(lotsDeLaLinea()).toEqual(['T1', 'T2'])
    expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
  })

  it('does not create a second move when the call that creates the move answered too late but did create it', async () => {
    const sesion = await crearRecepcion(['T1', 'T2'])
    odoo.fallo = { modelo: 'stock.move', metodo: 'create', despues: true }

    await expect(syncRecepcionSession(sesion.id)).rejects.toBeInstanceOf(OdooError)
    expect(odoo.movimientos).toHaveLength(1)
    expect(odoo.lineas).toHaveLength(0)

    await syncRecepcionSession(sesion.id)

    expect(odoo.movimientos).toHaveLength(1)
    expect(lotsDeLaLinea()).toEqual(['T1', 'T2'])
    expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
  })

  it('records the move on its courier batch and the packages as synced once the retry gets through', async () => {
    const sesion = await crearRecepcion(['T1'])
    odoo.fallo = { modelo: 'stock.move.line', metodo: 'create', despues: false }
    await expect(syncRecepcionSession(sesion.id)).rejects.toBeInstanceOf(OdooError)

    await syncRecepcionSession(sesion.id)

    const [tanda] = await db.select().from(sesionCourierBatches).where(eq(sesionCourierBatches.sesionId, sesion.id))
    expect(tanda.odooMoveId).toBe(odoo.movimientos[0].id)
    expect((await db.select().from(sesionItems)).map((i) => i.estado)).toEqual(['sincronizado'])
    expect(await db.select().from(trackingActivosCache)).toMatchObject([{ trackingNumber: 'T1', odooPickingId: odoo.pickingId }])
  })
})

describe('a picking that does not end up done', () => {
  it.each([
    ['an action that asks to confirm something', { res_model: 'stock.backorder.confirmation' }],
    ['false', false],
    ['nothing', null],
  ])('ends in error, not synced, when Odoo answers to the validation with %s', async (_caso, respuesta) => {
    const sesion = await crearRecepcion(['T1'])
    odoo.respuestaDeValidar = respuesta

    const error = await syncRecepcionSession(sesion.id).catch((e) => e)

    expect(error).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(clasificarError(error)).toBe('odoo') // nothing a retry fixes
    expect(await falla(sesion.id, error)).toEqual({ final: true, tipo: 'odoo' })
    const fila = await filaSesion(sesion.id)
    expect(fila.estado).toBe('error')
    expect(fila.syncedAt).toBeNull()
    expect(odoo.estadoDelPicking).not.toBe('done')
  })

  it('does not post the note nor write Recibido por on a picking that was not validated', async () => {
    const sesion = await crearRecepcion(['T1'])
    odoo.respuestaDeValidar = { res_model: 'stock.backorder.confirmation' }

    await expect(syncRecepcionSession(sesion.id)).rejects.toBeInstanceOf(RespuestaOdooInesperadaError)

    const metodos = vi.mocked(odooCall).mock.calls.map(([, metodo]) => metodo)
    expect(metodos).not.toContain('message_post')
    expect(metodos).not.toContain('write')
  })

  it('ends in error, not synced, for a picking somebody cancelled in Odoo, and says so', async () => {
    const sesion = await crearRecepcion(['T1'])
    // The picking is cancelled after the first attempt made it, and before the retry.
    odoo.fallo = { modelo: 'stock.move', metodo: 'create', despues: false }
    await expect(syncRecepcionSession(sesion.id)).rejects.toBeInstanceOf(OdooError)
    odoo.estadoDelPicking = 'cancel'

    const error = await syncRecepcionSession(sesion.id).catch((e) => e)

    expect(error).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(error.message).toBe('El albarán se canceló en Odoo.')
    expect(clasificarError(error)).toBe('odoo') // not retried
    expect(await falla(sesion.id, error)).toEqual({ final: true, tipo: 'odoo' })
    expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'error', ultimoError: 'El albarán se canceló en Odoo.' })
  })

  it('puts nothing in a cancelled picking, and does not tell the cache its packages are in Odoo', async () => {
    const sesion = await crearRecepcion(['T1'])
    odoo.fallo = { modelo: 'stock.move', metodo: 'create', despues: false }
    await expect(syncRecepcionSession(sesion.id)).rejects.toBeInstanceOf(OdooError)
    odoo.estadoDelPicking = 'cancel'

    await expect(syncRecepcionSession(sesion.id)).rejects.toThrow('El albarán se canceló en Odoo.')

    expect(odoo.movimientos).toHaveLength(0)
    expect(odoo.lineas).toHaveLength(0)
    expect(await db.select().from(trackingActivosCache)).toEqual([])
    expect((await db.select().from(sesionItems)).map((i) => i.estado)).toEqual(['ok'])
  })
})
