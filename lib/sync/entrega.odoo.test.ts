import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Unlike entrega.test.ts, nothing of lib/odoo/pickings is replaced here: only the HTTP call is, by a small Odoo
// that remembers what is done in it. What is under test is what the worker does with each answer Odoo can give to
// the validation, and for that the worker and `validarEntrega` have to run together.
vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('@/lib/odoo/client', () => ({ odooCall: vi.fn() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { sesionesEscaneo, type Almacen, type Operario } from '@/db/schema'
import { clasificarError, RespuestaOdooInesperadaError } from '@/lib/errores'
import { odooCall } from '@/lib/odoo/client'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { registrarFalloSync } from './estado'
import { syncEntregaSession } from './entrega'

const FIRMA = 'iVBORw0KGgo='
const RECIBIDO_POR = 'x_studio_recibido_por_2'
const PICKING_ID = 700

/** What the Odoo of the test has, and what it is told to answer to the validation. */
const odoo = {
  estado: 'assigned',
  lineas: [1, 2, 3],
  picked: new Set<number>(),
  firmado: false,
  /** What `button_validate` answers: `true` when it validated, an action when it wants something. */
  respuestaDeValidar: true as unknown,
  /** The picking ends up done although the answer is not `true`: Odoo finished and answered with a report to print. */
  validaAunqueResponda: false,
}

function odooResponde(modelo: string, metodo: string, params: Record<string, unknown> = {}): unknown {
  if (modelo === 'stock.move.line' && metodo === 'write') {
    const { ids, vals } = params as { ids: number[]; vals: { picked: boolean } }
    for (const id of ids) {
      if (vals.picked) odoo.picked.add(id)
      else odoo.picked.delete(id)
    }
    return true
  }
  if (modelo !== 'stock.picking') return true
  if (metodo === 'read') {
    const campos: Record<string, unknown> = {
      id: PICKING_ID,
      state: odoo.estado,
      move_line_ids: odoo.lineas,
      is_signed: odoo.firmado,
      picking_type_id: [2, 'MB92: Entregas'],
      x_studio_barco: [673, 'MAYANQUEEN'],
    }
    return [Object.fromEntries(['id', ...(params.fields as string[])].map((campo) => [campo, campos[campo]]))]
  }
  if (metodo === 'button_validate') {
    if (odoo.respuestaDeValidar === true || odoo.validaAunqueResponda) {
      odoo.estado = 'done'
      // What was not picked goes to a backorder: the delivery keeps the lines it delivered.
      odoo.lineas = odoo.lineas.filter((linea) => odoo.picked.has(linea))
    }
    return odoo.respuestaDeValidar
  }
  if (metodo === 'write') {
    const { vals } = params as { vals: Record<string, unknown> }
    if ('signature' in vals) odoo.firmado = true
  }
  return true // message_post, write
}

let veronika: Operario
let mb92: Almacen

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  Object.assign(odoo, {
    estado: 'assigned', lineas: [1, 2, 3], picked: new Set<number>(), firmado: false,
    respuestaDeValidar: true, validaAunqueResponda: false,
  })
  vi.stubEnv('ODOO_FIELD_BARCO', 'x_studio_barco')
  vi.stubEnv('ODOO_FIELD_RECIBIDO_POR', RECIBIDO_POR)
  vi.mocked(odooCall).mockImplementation(async (modelo, metodo, params) => odooResponde(modelo, metodo, params ?? {}) as never)

  veronika = await seedOperario(db, { nombre: 'Veronika' })
  mb92 = await seedAlmacen(db)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** An entrega waiting for its sync: two of the three packages of the delivery were handed over. */
async function crearEntrega() {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: veronika.id,
    almacenId: mb92.id,
    barcoOdooId: 673,
    tipo: 'entrega',
    estado: 'confirmada_pendiente_sync',
    odooPickingIds: [PICKING_ID],
    odooMoveLineIds: [1, 2],
    firmaData: FIRMA,
    receptorNombre: 'Capitán Pérez',
    confirmedAt: new Date(),
  }).returning()
  return sesion
}

const filaSesion = async (id: string) =>
  (await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, id)))[0]

const llamadasAOdoo = (modelo: string, metodo: string) =>
  vi.mocked(odooCall).mock.calls.filter(([m, me]) => m === modelo && me === metodo).map(([, , params]) => params)

/** The reads of the state of a picking alone: the worker and `validarEntrega` read other fields before validating. */
const lecturasDelEstado = () =>
  llamadasAOdoo('stock.picking', 'read').filter((params) => JSON.stringify((params as { fields: string[] }).fields) === '["state"]')

describe('a delivery that Odoo validated and answered with an action', () => {
  // `auto_print_delivery_slip` is common on the delivery types: `button_validate` finishes the work and answers with
  // the action that prints the slip, instead of `true`. The picking is done.
  it('syncs the entrega, signed and noted, when the answer is a report to print and the picking is done', async () => {
    const sesion = await crearEntrega()
    odoo.respuestaDeValidar = { type: 'ir.actions.client', tag: 'do_multi_print' }
    odoo.validaAunqueResponda = true

    await syncEntregaSession(sesion.id)

    expect(odoo.estado).toBe('done')
    expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'sincronizada', ultimoError: null, ultimoErrorTipo: null })
    expect(llamadasAOdoo('stock.picking', 'write')).toEqual([
      { ids: [PICKING_ID], vals: { signature: FIRMA, [RECIBIDO_POR]: 'Capitán Pérez' } },
    ])
    expect(llamadasAOdoo('stock.picking', 'message_post')).toEqual([
      {
        ids: [PICKING_ID],
        body: 'Entregado a Capitán Pérez vía Webapp Paquetería por Veronika: 2 paquete(s); 1 quedan en depósito',
      },
    ])
    expect(lecturasDelEstado()).toHaveLength(1) // because the answer was not `true`
  })

  it('does not read the state of the picking after the validation when Odoo answers true', async () => {
    const sesion = await crearEntrega()

    await syncEntregaSession(sesion.id)

    expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'sincronizada' })
    expect(lecturasDelEstado()).toHaveLength(0)
  })
})

describe('a delivery that does not end up done', () => {
  it.each([
    ['the wizard that asks about the backorder', { type: 'ir.actions.act_window', res_model: 'stock.backorder.confirmation' }, 'Odoo pidió confirmar (stock.backorder.confirmation)'],
    ['a report to print, with the picking not done', { type: 'ir.actions.client', tag: 'do_multi_print' }, 'Odoo pidió confirmar (do_multi_print)'],
  ])('ends in error, signed and noted by nobody, when Odoo answers with %s', async (_caso, respuesta, mensaje) => {
    const sesion = await crearEntrega()
    odoo.respuestaDeValidar = respuesta

    const error = await syncEntregaSession(sesion.id).catch((e) => e)

    expect(error).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(error.message).toBe(mensaje)
    expect(clasificarError(error)).toBe('odoo') // nothing a retry fixes
    expect(await registrarFalloSync({ sesionId: sesion.id, error, reintentosHechos: 0 })).toEqual({ final: true, tipo: 'odoo' })
    expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'error', ultimoErrorTipo: 'odoo', syncedAt: null })
    expect(odoo.estado).not.toBe('done')
    expect(llamadasAOdoo('stock.picking', 'write')).toEqual([])
    expect(llamadasAOdoo('stock.picking', 'message_post')).toEqual([])
  })
})
