import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
// Nothing here reaches Odoo. `validarEntrega` has its own module and its own tests; `odooCall` is what the
// worker uses to read each picking, to write the signature and the crew name, and to leave the note.
vi.mock('@/lib/odoo/pickings', () => ({ validarEntrega: vi.fn() }))
vi.mock('@/lib/odoo/client', () => ({ odooCall: vi.fn() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog, sesionesEscaneo, type Almacen, type Operario } from '@/db/schema'
import { ConfiguracionError } from '@/lib/errores'
import { odooCall } from '@/lib/odoo/client'
import { validarEntrega } from '@/lib/odoo/pickings'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { syncEntregaSession } from './entrega'

const RECIBIDO_POR = 'x_studio_recibido_por_2'
/** The signature as registrarEntrega stores it: bare base64, no `data:` prefix. */
const FIRMA = 'iVBORw0KGgo='

interface PickingEnOdoo {
  state: string
  move_line_ids: number[]
  is_signed: boolean
}

let veronika: Operario
let mb92: Almacen
/** The pickings Odoo has, by id: what the mocked `odooCall` reads and what `validarEntrega` changes. */
let odoo: Map<number, PickingEnOdoo>
/** An error the next write to a picking throws (once), to cut a run in the middle. */
let falloAlEscribir: Error | null

/** A picking as Odoo has it before the delivery: assigned, unsigned, with lines 1 and 2 unless said. */
function odooTiene(id: number, datos: Partial<PickingEnOdoo> = {}) {
  odoo.set(id, { state: 'assigned', move_line_ids: [1, 2], is_signed: false, ...datos })
}

/**
 * Odoo as the worker sees it. `read` answers only the fields it is asked for, like the real one, and a
 * write that brings a signature makes the picking signed, since `is_signed` is computed from it.
 */
function odooResponde(modelo: string, metodo: string, params: Record<string, unknown> = {}): unknown {
  if (modelo !== 'stock.picking') return true
  const { ids, fields, vals } = params as { ids: number[]; fields?: string[]; vals?: Record<string, unknown> }
  const picking = odoo.get(ids[0])
  if (metodo === 'read') {
    if (!picking) return []
    const campos: Record<string, unknown> = { id: ids[0], ...picking }
    return [Object.fromEntries(['id', ...(fields ?? [])].map((campo) => [campo, campos[campo]]))]
  }
  if (metodo === 'write') {
    if (falloAlEscribir) {
      const error = falloAlEscribir
      falloAlEscribir = null
      throw error
    }
    if (picking && vals && 'signature' in vals) picking.is_signed = true
  }
  return true // message_post, write
}

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  odoo = new Map()
  falloAlEscribir = null
  vi.stubEnv('ODOO_FIELD_RECIBIDO_POR', RECIBIDO_POR)

  veronika = await seedOperario(db, { nombre: 'Veronika' })
  mb92 = await seedAlmacen(db)

  vi.mocked(odooCall).mockImplementation(async (modelo, metodo, params) => odooResponde(modelo, metodo, params) as never)
  // What Odoo does with a delivery: the picking ends up done with the lines delivered, and the rest go to a backorder.
  vi.mocked(validarEntrega).mockImplementation(async ({ pickingId, moveLineIdsElegidas }) => {
    const picking = odoo.get(pickingId) as PickingEnOdoo
    const quedan = picking.move_line_ids.filter((linea) => !moveLineIdsElegidas.includes(linea))
    picking.state = 'done'
    picking.move_line_ids = picking.move_line_ids.filter((linea) => moveLineIdsElegidas.includes(linea))
    return { quedanEnDeposito: quedan.length }
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** An entrega waiting for its sync, written straight to the database the way registrarEntrega leaves it. */
async function crearEntrega(datos: Partial<typeof sesionesEscaneo.$inferInsert> = {}) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: veronika.id,
    almacenId: mb92.id,
    barcoOdooId: 673,
    tipo: 'entrega',
    estado: 'confirmada_pendiente_sync',
    odooPickingIds: [700],
    odooMoveLineIds: [1, 2],
    firmaData: FIRMA,
    receptorNombre: 'Capitán Pérez',
    confirmedAt: new Date(),
    ...datos,
  }).returning()
  return sesion
}

const filaSesion = async (id: string) =>
  (await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, id)))[0]

/** The params of every call made to Odoo through odooCall with this model and method, in order. */
const llamadasAOdoo = (modelo: string, metodo: string) =>
  vi.mocked(odooCall).mock.calls.filter(([m, me]) => m === modelo && me === metodo).map(([, , params]) => params)

/** Where in the run of all the mocks the first call of `odooCall` with this method happened. */
const ordenDeOdoo = (metodo: string) =>
  vi.mocked(odooCall).mock.invocationCallOrder[vi.mocked(odooCall).mock.calls.findIndex(([, me]) => me === metodo)]

describe('syncEntregaSession', () => {
  it('validates only pickings with chosen lines, then writes signature and crew name', async () => {
    odooTiene(700, { move_line_ids: [1, 2, 3] }) // one of its three packages stays in depósito
    odooTiene(701, { move_line_ids: [4, 5] })
    odooTiene(702, { move_line_ids: [6] }) // none of its packages was chosen
    const sesion = await crearEntrega({ odooPickingIds: [700, 701, 702], odooMoveLineIds: [1, 2, 4, 5] })

    await syncEntregaSession(sesion.id)

    expect(vi.mocked(validarEntrega).mock.calls).toEqual([
      [{ pickingId: 700, moveLineIdsElegidas: [1, 2] }],
      [{ pickingId: 701, moveLineIdsElegidas: [4, 5] }],
    ])
    // Exactly the signature and the name: `is_signed` is computed by Odoo and is never written.
    expect(llamadasAOdoo('stock.picking', 'write')).toEqual([
      { ids: [700], vals: { signature: FIRMA, [RECIBIDO_POR]: 'Capitán Pérez' } },
      { ids: [701], vals: { signature: FIRMA, [RECIBIDO_POR]: 'Capitán Pérez' } },
    ])
    expect(llamadasAOdoo('stock.picking', 'message_post').map((nota) => (nota as { ids: number[] }).ids)).toEqual([[700], [701]])
    expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
  })

  it('reads the state, the lines and whether it is signed of each picking, one read per picking', async () => {
    odooTiene(700)
    odooTiene(701, { move_line_ids: [3] })
    const sesion = await crearEntrega({ odooPickingIds: [700, 701], odooMoveLineIds: [1, 3] })

    await syncEntregaSession(sesion.id)

    expect(llamadasAOdoo('stock.picking', 'read')).toEqual([
      { ids: [700], fields: ['state', 'move_line_ids', 'is_signed'] },
      { ids: [701], fields: ['state', 'move_line_ids', 'is_signed'] },
    ])
  })

  it('validates a picking before signing it, and signs it before leaving the note', async () => {
    odooTiene(700, { move_line_ids: [1, 2, 3] })
    const sesion = await crearEntrega({ odooMoveLineIds: [1, 2] })

    await syncEntregaSession(sesion.id)

    const orden = {
      leer: vi.mocked(odooCall).mock.invocationCallOrder[0],
      validar: vi.mocked(validarEntrega).mock.invocationCallOrder[0],
      firmar: ordenDeOdoo('write'),
      nota: ordenDeOdoo('message_post'),
    }
    expect(orden.leer).toBeLessThan(orden.validar)
    // The signature and the name go after validating: if they went before, the backorder would inherit them.
    expect(orden.validar).toBeLessThan(orden.firmar)
    expect(orden.firmar).toBeLessThan(orden.nota)
  })

  it('a retry after validation writes the missing signature without validating again', async () => {
    odooTiene(700, { move_line_ids: [1, 2, 3] })
    const sesion = await crearEntrega({ odooMoveLineIds: [1, 2] })
    falloAlEscribir = new Error('Odoo se cayó') // the picking is validated, and the connection drops when signing it

    await expect(syncEntregaSession(sesion.id)).rejects.toThrow('Odoo se cayó')
    expect(validarEntrega).toHaveBeenCalledTimes(1)
    expect(odoo.get(700)).toMatchObject({ state: 'done', is_signed: false })
    expect(llamadasAOdoo('stock.picking', 'message_post')).toEqual([])
    expect((await filaSesion(sesion.id)).estado).toBe('confirmada_pendiente_sync')

    await syncEntregaSession(sesion.id)

    expect(validarEntrega).toHaveBeenCalledTimes(1) // not validated a second time
    expect(llamadasAOdoo('stock.picking', 'write')).toEqual([
      { ids: [700], vals: { signature: FIRMA, [RECIBIDO_POR]: 'Capitán Pérez' } }, // the one that failed
      { ids: [700], vals: { signature: FIRMA, [RECIBIDO_POR]: 'Capitán Pérez' } },
    ])
    // The note is left by the run that signed. It cannot say what stayed in depósito: that was known only to the run that validated.
    expect(llamadasAOdoo('stock.picking', 'message_post')).toEqual([
      { ids: [700], body: 'Entregado a Capitán Pérez vía Webapp Paquetería por Veronika: 2 paquete(s)' },
    ])
    expect(odoo.get(700)).toMatchObject({ state: 'done', is_signed: true })
    expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
  })

  it('skips a picking already done and signed', async () => {
    odooTiene(700, { state: 'done', is_signed: true })
    const sesion = await crearEntrega()

    await syncEntregaSession(sesion.id)

    expect(validarEntrega).not.toHaveBeenCalled()
    expect(llamadasAOdoo('stock.picking', 'write')).toEqual([])
    expect(llamadasAOdoo('stock.picking', 'message_post')).toEqual([]) // it did nothing, so there is nothing to note
    expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
  })

  it('works through the pickings one by one: the one already done is only signed, the one not done is validated and signed', async () => {
    odooTiene(700, { state: 'done' })
    odooTiene(701, { move_line_ids: [3, 4] })
    const sesion = await crearEntrega({ odooPickingIds: [700, 701], odooMoveLineIds: [1, 2, 3, 4] })

    await syncEntregaSession(sesion.id)

    expect(vi.mocked(validarEntrega).mock.calls).toEqual([[{ pickingId: 701, moveLineIdsElegidas: [3, 4] }]])
    expect(llamadasAOdoo('stock.picking', 'write').map((escritura) => (escritura as { ids: number[] }).ids)).toEqual([[700], [701]])
  })

  it('validates a picking that is already signed without signing it again', async () => {
    odooTiene(700, { is_signed: true })
    const sesion = await crearEntrega()

    await syncEntregaSession(sesion.id)

    expect(validarEntrega).toHaveBeenCalledTimes(1)
    expect(llamadasAOdoo('stock.picking', 'write')).toEqual([]) // neither its signature nor its Recibido por is overwritten
    expect(llamadasAOdoo('stock.picking', 'message_post')).toHaveLength(1)
  })

  describe('the chatter note', () => {
    it('names the crew member and the packages left in depósito', async () => {
      odooTiene(700, { move_line_ids: [1, 2, 3] })
      const sesion = await crearEntrega({ odooMoveLineIds: [1, 2] })

      await syncEntregaSession(sesion.id)

      expect(llamadasAOdoo('stock.picking', 'message_post')).toEqual([
        { ids: [700], body: 'Entregado a Capitán Pérez vía Webapp Paquetería por Veronika: 2 paquete(s); 1 quedan en depósito' },
      ])
    })

    it('names the operario and not their id, and says nothing about depósito when everything was delivered', async () => {
      odooTiene(700, { move_line_ids: [1, 2, 3] })
      const sesion = await crearEntrega({ odooMoveLineIds: [1, 2, 3], receptorNombre: 'Ana Ruiz' })

      await syncEntregaSession(sesion.id)

      const [nota] = llamadasAOdoo('stock.picking', 'message_post') as Array<{ body: string }>
      expect(nota.body).toBe('Entregado a Ana Ruiz vía Webapp Paquetería por Veronika: 3 paquete(s)')
      expect(nota.body).not.toContain(veronika.id)
      expect(nota.body).not.toContain('depósito')
    })

    it('counts the packages of each picking on its own', async () => {
      odooTiene(700, { move_line_ids: [1, 2, 3] })
      odooTiene(701, { move_line_ids: [4] })
      const sesion = await crearEntrega({ odooPickingIds: [700, 701], odooMoveLineIds: [1, 4] })

      await syncEntregaSession(sesion.id)

      expect(llamadasAOdoo('stock.picking', 'message_post')).toEqual([
        { ids: [700], body: 'Entregado a Capitán Pérez vía Webapp Paquetería por Veronika: 1 paquete(s); 2 quedan en depósito' },
        { ids: [701], body: 'Entregado a Capitán Pérez vía Webapp Paquetería por Veronika: 1 paquete(s)' },
      ])
    })
  })

  describe('when it succeeds', () => {
    it('leaves the entrega synced with nothing left over from earlier attempts, and audits it', async () => {
      odooTiene(700)
      odooTiene(701, { move_line_ids: [3] })
      const sesion = await crearEntrega({
        odooPickingIds: [700, 701],
        odooMoveLineIds: [1, 2, 3],
        intentos: 1,
        ultimoError: 'fetch failed',
        ultimoErrorTipo: 'conexion', // from an earlier attempt that QStash then retried
      })

      await syncEntregaSession(sesion.id)

      const fila = await filaSesion(sesion.id)
      expect(fila).toMatchObject({ estado: 'sincronizada', ultimoError: null, ultimoErrorTipo: null, intentos: 1 })
      expect(Math.abs((fila.syncedAt as Date).getTime() - Date.now())).toBeLessThan(5_000)
      const auditoria = await db.select().from(auditLog)
      expect(auditoria).toHaveLength(1)
      expect(auditoria[0]).toMatchObject({ accion: 'sync_ok', operarioId: null })
      expect(auditoria[0].detalle).toEqual({ sesionId: sesion.id, odooPickingIds: [700, 701] })
    })

    it('clears the earlier failure too when it had nothing left to do in Odoo', async () => {
      odooTiene(700, { state: 'done', is_signed: true })
      const sesion = await crearEntrega({ ultimoError: 'Odoo HTTP 500: caído', ultimoErrorTipo: 'conexion' })

      await syncEntregaSession(sesion.id)

      expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'sincronizada', ultimoError: null, ultimoErrorTipo: null })
    })

    it('syncs an entrega none of whose pickings has a chosen line left, without touching them', async () => {
      odooTiene(700, { move_line_ids: [8, 9] }) // the chosen lines are no longer on it
      const sesion = await crearEntrega({ odooMoveLineIds: [1, 2] })

      await syncEntregaSession(sesion.id)

      expect(validarEntrega).not.toHaveBeenCalled()
      expect(llamadasAOdoo('stock.picking', 'write')).toEqual([])
      expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
    })
  })

  describe('what an admin has to fix', () => {
    it.each([
      ['unset', undefined],
      ['empty', ''],
    ])('throws ConfiguracionError when ODOO_FIELD_RECIBIDO_POR is %s', async (_caso, valor) => {
      vi.stubEnv('ODOO_FIELD_RECIBIDO_POR', valor)
      odooTiene(700)
      const sesion = await crearEntrega()
      const antes = await filaSesion(sesion.id)

      const error = await syncEntregaSession(sesion.id).catch((e) => e)

      expect(error).toBeInstanceOf(ConfiguracionError)
      expect(error.message).toBe('ODOO_FIELD_RECIBIDO_POR no está configurado')
      // Before anything is done in Odoo: no picking is left validated without its name.
      expect(odooCall).not.toHaveBeenCalled()
      expect(validarEntrega).not.toHaveBeenCalled()
      expect(await filaSesion(sesion.id)).toEqual(antes) // registrarFalloSync is the one that moves it to error
    })
  })

  describe('a message that arrives when the entrega is not waiting for its sync', () => {
    // 'sincronizada': QStash delivered a message whose run already finished. 'en_curso': never the case for an
    // entrega, but nothing but a waiting one is the worker's. 'error': it failed for good, and Pendientes puts it
    // back to confirmada_pendiente_sync before queuing it again, so a message from before that is a stale one.
    it.each(['sincronizada', 'en_curso', 'error'] as const)('does nothing, in Odoo or here, for an entrega that is %s', async (estado) => {
      odooTiene(700)
      const sesion = await crearEntrega({ estado, ultimoError: 'Odoo HTTP 422: no', ultimoErrorTipo: 'odoo', intentos: 3 })
      const antes = await filaSesion(sesion.id)

      await expect(syncEntregaSession(sesion.id)).resolves.toBeUndefined()

      expect(odooCall).not.toHaveBeenCalled()
      expect(validarEntrega).not.toHaveBeenCalled()
      expect(await filaSesion(sesion.id)).toEqual(antes)
      expect(odoo.get(700)).toEqual({ state: 'assigned', move_line_ids: [1, 2], is_signed: false })
      expect(await db.select().from(auditLog)).toEqual([])
    })

    it('does not complain about the configuration either: failing would send a finished entrega to error', async () => {
      vi.stubEnv('ODOO_FIELD_RECIBIDO_POR', undefined)
      const sesion = await crearEntrega({ estado: 'sincronizada' })

      await expect(syncEntregaSession(sesion.id)).resolves.toBeUndefined()
    })
  })

  describe('when something fails', () => {
    it('leaves the entrega waiting, and signs and notes nothing, when validating the picking fails', async () => {
      odooTiene(700)
      odooTiene(701, { move_line_ids: [3] })
      const sesion = await crearEntrega({ odooPickingIds: [700, 701], odooMoveLineIds: [1, 2, 3] })
      vi.mocked(validarEntrega).mockRejectedValue(new Error('Odoo pidió confirmar (stock.backorder.confirmation)'))

      await expect(syncEntregaSession(sesion.id)).rejects.toThrow('Odoo pidió confirmar (stock.backorder.confirmation)')

      expect(validarEntrega).toHaveBeenCalledTimes(1) // it stops there: the next picking is for the retry
      expect(llamadasAOdoo('stock.picking', 'write')).toEqual([])
      expect(llamadasAOdoo('stock.picking', 'message_post')).toEqual([])
      expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'confirmada_pendiente_sync', syncedAt: null })
      expect(await db.select().from(auditLog)).toEqual([])
    })

    it('throws a readable error when a picking no longer exists in Odoo', async () => {
      odooTiene(700)
      const sesion = await crearEntrega({ odooPickingIds: [700, 999], odooMoveLineIds: [1, 2] })

      await expect(syncEntregaSession(sesion.id)).rejects.toThrow('picking 999 no existe en Odoo')

      // What was done to the first picking stays done: the retry finds it signed and goes on from the second.
      expect(odoo.get(700)).toMatchObject({ state: 'done', is_signed: true })
      expect((await filaSesion(sesion.id)).estado).toBe('confirmada_pendiente_sync')
    })

    it.each([
      ['picking ids', { odooPickingIds: null }],
      ['chosen lines', { odooMoveLineIds: null }],
      ['signature', { firmaData: null }],
      ['crew name', { receptorNombre: null }],
    ] as const)('throws, without touching Odoo, when the entrega has no %s', async (_falta, datos) => {
      odooTiene(700)
      const sesion = await crearEntrega(datos)

      await expect(syncEntregaSession(sesion.id)).rejects.toThrow(/no tiene/)

      expect(odooCall).not.toHaveBeenCalled()
      expect((await filaSesion(sesion.id)).estado).toBe('confirmada_pendiente_sync')
    })
  })

  it('throws when the entrega does not exist', async () => {
    await expect(syncEntregaSession('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/no encontrada/)
    expect(odooCall).not.toHaveBeenCalled()
  })
})
