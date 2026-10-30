import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Nothing of lib/odoo/reasignacion is replaced: only the HTTP call is, by a small Odoo of deliveries that does what it is
// asked as Odoo does. What is under test is what the worker leaves in Odoo, also when a run is cut and retried.
vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('@/lib/odoo/client', () => ({ odooCall: vi.fn() }))

import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog, sesionesEscaneo, type Almacen, type Operario } from '@/db/schema'
import { clasificarError, ConfiguracionError, RespuestaOdooInesperadaError } from '@/lib/errores'
import { odooCall } from '@/lib/odoo/client'
import { ORIGEN_CAMBIO_DE_BARCO } from '@/lib/odoo/reasignacion'
import { OdooDeEntregas } from '@/lib/testing/odoo-de-entregas'
import { seedAlmacen, seedBarco, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { syncReasignacionSession } from './reasignacion'

const BARCO = 'x_studio_barco'
/** MAYANQUEEN got packages of ARCTIC by mistake. */
const MAYANQUEEN = 673
const ARCTIC = 674

let veronika: Operario
let mb92: Almacen
let odoo: OdooDeEntregas

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  vi.stubEnv('ODOO_FIELD_BARCO', BARCO)

  veronika = await seedOperario(db, { nombre: 'Veronika' })
  mb92 = await seedAlmacen(db)
  await seedBarco(db, { odooId: MAYANQUEEN, nombre: 'MAYANQUEEN' })
  await seedBarco(db, { odooId: ARCTIC, nombre: 'ARCTIC' })

  odoo = new OdooDeEntregas(BARCO)
  vi.mocked(odooCall).mockImplementation(async (modelo, metodo, params) => odoo.responder(modelo, metodo, params) as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * The delivery of MAYANQUEEN: two DHL packages (a move of their own) and three GLS ones of another recepción. With
 * `conEntregaDeArctic`, ARCTIC has a delivery waiting too, with one package.
 */
function odooConEntregas({ conEntregaDeArctic }: { conEntregaDeArctic: boolean }) {
  odoo.entrega({ id: 700, barco: MAYANQUEEN })
  odoo.movimiento({ id: 100, picking: 700, lineas: [1, 2], lotes: ['QA-DHL-001', 'QA-DHL-002'], origenes: [10] })
  odoo.movimiento({ id: 101, picking: 700, lineas: [3, 4, 5], lotes: ['QA-GLS-001', 'QA-GLS-002', 'QA-GLS-003'], producto: 12, origenes: [11] })
  if (conEntregaDeArctic) {
    odoo.entrega({ id: 800, barco: ARCTIC })
    odoo.movimiento({ id: 900, picking: 800, lineas: [90], lotes: ['QA-ARCTIC-001'] })
  }
}

/** The packages of the lines, as the action keeps them: in the same order. */
function paquetesDe(lineas: number[]) {
  return lineas.map((linea) => ({ trackingNumber: odoo.lineas.get(linea)?.lote ?? null, courierNombre: 'DHL', pickingRef: 'MB92/OUT/00700' }))
}

/** A reasignación of MAYANQUEEN to ARCTIC waiting for its sync, written the way registrarReasignacion leaves it. */
async function crearReasignacion(lineas: number[], datos: Partial<typeof sesionesEscaneo.$inferInsert> = {}) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: veronika.id,
    almacenId: mb92.id,
    barcoOdooId: MAYANQUEEN,
    barcoDestinoOdooId: ARCTIC,
    tipo: 'reasignacion',
    estado: 'confirmada_pendiente_sync',
    odooPickingIds: [700],
    odooMoveLineIds: lineas,
    paquetesDeOdoo: paquetesDe(lineas),
    confirmedAt: new Date(),
    ...datos,
  }).returning()
  return sesion
}

async function filaSesion(id: string) {
  const [fila] = await db.select().from(sesionesEscaneo).where(eq(sesionesEscaneo.id, id))
  return fila
}

/** Where every package is and what every move asks for, without the ids Odoo gives as it goes. */
function lugaresDeLosPaquetes() {
  return [...odoo.pickings.values()].sort((a, b) => a.id - b.id).map((picking) => ({
    barco: picking.barco,
    origin: picking.origin,
    estado: odoo.estadoDe(picking.id),
    movimientos: odoo.movimientosDe(picking.id).map((movimiento) => ({
      producto: movimiento.producto,
      demanda: movimiento.demanda,
      estado: movimiento.state,
      origenes: movimiento.origenes,
      paquetes: [...odoo.lineas.values()].filter((linea) => linea.movimiento === movimiento.id).map((linea) => linea.lote).sort(),
    })).sort((a, b) => a.paquetes.join().localeCompare(b.paquetes.join())),
  }))
}

describe('syncReasignacionSession', () => {
  it('moves the packages to the delivery of the destino, notes both deliveries and ends synced', async () => {
    odooConEntregas({ conEntregaDeArctic: true })
    const sesion = await crearReasignacion([1, 2, 4])

    await syncReasignacionSession(sesion.id)

    expect(odoo.lineasDe(800).map((linea) => linea.lote)).toEqual(['QA-DHL-001', 'QA-DHL-002', 'QA-GLS-002', 'QA-ARCTIC-001'])
    expect(odoo.lineasDe(700).map((linea) => linea.lote)).toEqual(['QA-GLS-001', 'QA-GLS-003'])
    expect(odoo.movimientos.get(101)).toMatchObject({ picking: 700, demanda: 2 })
    expect(odoo.pickings.get(800)?.notas).toEqual([
      'Se pasaron 3 paquete(s) de MAYANQUEEN (MB92/OUT/00700) vía Webapp Paquetería por Veronika: QA-DHL-001, QA-DHL-002, QA-GLS-002',
    ])
    expect(odoo.pickings.get(700)?.notas).toEqual([
      'Se pasaron 3 paquete(s) a ARCTIC (MB92/OUT/00800) vía Webapp Paquetería por Veronika: QA-DHL-001, QA-DHL-002, QA-GLS-002',
    ])

    const fila = await filaSesion(sesion.id)
    expect(fila).toMatchObject({ estado: 'sincronizada', odooPickingId: 800, odooPickingRef: 'MB92/OUT/00800', ultimoError: null })
    expect(fila.syncedAt).toBeInstanceOf(Date)
    const auditoria = await db.select().from(auditLog)
    expect(auditoria).toEqual([expect.objectContaining({
      operarioId: null, accion: 'sync_ok', detalle: { sesionId: sesion.id, odooPickingRef: 'MB92/OUT/00800' },
    })])
  })

  it('cancels the delivery of origen when every package of it goes, and says so in its note', async () => {
    odooConEntregas({ conEntregaDeArctic: true })
    const sesion = await crearReasignacion([1, 2, 3, 4, 5])

    await syncReasignacionSession(sesion.id)

    expect(odoo.estadoDe(700)).toBe('cancel')
    expect(odoo.pickings.get(700)?.notas).toEqual([
      'Se pasaron 5 paquete(s) a ARCTIC (MB92/OUT/00800) vía Webapp Paquetería por Veronika: '
        + 'QA-DHL-001, QA-DHL-002, QA-GLS-001, QA-GLS-002, QA-GLS-003. La entrega quedó vacía y se canceló.',
    ])
  })

  it('makes a delivery of the destino when it has none waiting, and keeps it in the sesión', async () => {
    odooConEntregas({ conEntregaDeArctic: false })
    const sesion = await crearReasignacion([4])

    await syncReasignacionSession(sesion.id)

    const nuevas = [...odoo.pickings.values()].filter((picking) => picking.barco === ARCTIC)
    expect(nuevas).toHaveLength(1)
    expect(nuevas[0]).toMatchObject({ origin: ORIGEN_CAMBIO_DE_BARCO })
    expect(odoo.estadoDe(nuevas[0].id)).toBe('assigned')
    expect(odoo.lineasDe(nuevas[0].id).map((linea) => linea.lote)).toEqual(['QA-GLS-002'])
    expect(await filaSesion(sesion.id)).toMatchObject({ odooPickingId: nuevas[0].id, odooPickingRef: nuevas[0].name })
  })

  describe.each([
    { caso: 'a delivery of the destino waiting', conEntregaDeArctic: true },
    { caso: 'no delivery of the destino, so one is made', conEntregaDeArctic: false },
  ])('cut after any of its writes and retried, with $caso', ({ conEntregaDeArctic }) => {
    /** A whole run, uncut: what Odoo has to end with, and how many writes it takes. */
    async function referencia() {
      odooConEntregas({ conEntregaDeArctic })
      const sesion = await crearReasignacion([1, 2, 4])
      await syncReasignacionSession(sesion.id)
      return { lugares: lugaresDeLosPaquetes(), escrituras: odoo.escriturasHechas().length }
    }

    it('ends as a run that was not cut, with no move made twice', async () => {
      const esperado = await referencia()
      expect(esperado.escrituras).toBeGreaterThan(3)

      for (let corte = 0; corte < esperado.escrituras; corte += 1) {
        await resetTestDb(db as unknown as TestDb)
        veronika = await seedOperario(db, { nombre: 'Veronika' })
        mb92 = await seedAlmacen(db)
        await seedBarco(db, { odooId: MAYANQUEEN, nombre: 'MAYANQUEEN' })
        await seedBarco(db, { odooId: ARCTIC, nombre: 'ARCTIC' })
        odoo = new OdooDeEntregas(BARCO)
        odooConEntregas({ conEntregaDeArctic })
        const sesion = await crearReasignacion([1, 2, 4])

        odoo.cortarTrasEscrituras = corte
        const fallo = await syncReasignacionSession(sesion.id).catch((error: unknown) => error)
        expect(fallo, `cut after write ${corte}`).toBeInstanceOf(Error)
        // What the route does with it: a lost answer is a failure a retry can fix, and QStash delivers the message again.
        expect(clasificarError(fallo)).toBe('conexion')
        await syncReasignacionSession(sesion.id)

        expect(lugaresDeLosPaquetes(), `cut after write ${corte}`).toEqual(esperado.lugares)
        expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
      }
    })
  })

  it('notes both deliveries on a retry when the packages moved and the run was cut before its notes', async () => {
    odooConEntregas({ conEntregaDeArctic: true })
    const sesion = await crearReasignacion([1, 2, 4])
    // The split of the GLS move, then the hand-over to ARCTIC: the answer to the second write is lost.
    odoo.cortarTrasEscrituras = 1
    await expect(syncReasignacionSession(sesion.id)).rejects.toThrow()
    expect(odoo.pickings.get(800)?.notas).toEqual([])

    await syncReasignacionSession(sesion.id)

    expect(odoo.pickings.get(800)?.notas).toEqual([
      'Se pasaron 3 paquete(s) de MAYANQUEEN (MB92/OUT/00700) vía Webapp Paquetería por Veronika: QA-DHL-001, QA-DHL-002, QA-GLS-002',
    ])
    expect(odoo.pickings.get(700)?.notas).toEqual([
      'Se pasaron 3 paquete(s) a ARCTIC (MB92/OUT/00800) vía Webapp Paquetería por Veronika: QA-DHL-001, QA-DHL-002, QA-GLS-002',
    ])
    expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
  })

  it('says a delivery was cancelled on a retry too, when an earlier run emptied and cancelled it before its notes', async () => {
    odooConEntregas({ conEntregaDeArctic: true })
    const sesion = await crearReasignacion([1, 2, 3, 4, 5])
    // The hand-over, then the cancel of the emptied 700: the answer to the cancel is lost.
    odoo.cortarTrasEscrituras = 1
    await expect(syncReasignacionSession(sesion.id)).rejects.toThrow()
    expect(odoo.estadoDe(700)).toBe('cancel')

    await syncReasignacionSession(sesion.id)

    expect(odoo.pickings.get(700)?.notas).toEqual([
      'Se pasaron 5 paquete(s) a ARCTIC (MB92/OUT/00800) vía Webapp Paquetería por Veronika: '
        + 'QA-DHL-001, QA-DHL-002, QA-GLS-001, QA-GLS-002, QA-GLS-003. La entrega quedó vacía y se canceló.',
    ])
  })

  it('notes nothing when the webapp moved nothing: somebody had already put the packages on the destino', async () => {
    odooConEntregas({ conEntregaDeArctic: true })
    odoo.movimientos.get(100)!.picking = 800
    odoo.lineas.get(1)!.picking = 800
    odoo.lineas.get(2)!.picking = 800
    const sesion = await crearReasignacion([1, 2])

    await syncReasignacionSession(sesion.id)

    expect(odoo.escriturasHechas()).toEqual([])
    expect((await filaSesion(sesion.id)).estado).toBe('sincronizada')
  })

  it('leaves every move asking for what it has reserved: no phantom line on either barco', async () => {
    odooConEntregas({ conEntregaDeArctic: true })
    const sesion = await crearReasignacion([2, 4])

    await syncReasignacionSession(sesion.id)

    for (const movimiento of odoo.movimientos.values()) {
      expect(movimiento.demanda, `move ${movimiento.id}`).toBe(odoo.cantidadDe(movimiento.id))
    }
  })

  it('finds a package whose line an entrega made again in a backorder, and moves it all the same', async () => {
    // The entrega of MAYANQUEEN validated 700 with QA-DHL-002 left in depósito: Odoo made it again, as line 51, in 701.
    odooConEntregas({ conEntregaDeArctic: true })
    odoo.lineas.delete(2)
    odoo.movimientos.get(100)!.demanda = 1
    odoo.entrega({ id: 701, barco: MAYANQUEEN })
    odoo.movimiento({ id: 150, picking: 701, lineas: [51], lotes: ['QA-DHL-002'] })
    const sesion = await crearReasignacion([1])
    await db.update(sesionesEscaneo)
      .set({ odooMoveLineIds: [2], paquetesDeOdoo: [{ trackingNumber: 'QA-DHL-002', courierNombre: 'DHL', pickingRef: 'MB92/OUT/00700' }] })
      .where(eq(sesionesEscaneo.id, sesion.id))

    await syncReasignacionSession(sesion.id)

    expect(odoo.lineas.get(51)?.picking).toBe(800)
    expect(odoo.estadoDe(701)).toBe('cancel')
    // The note goes to the delivery it was on when it was confirmed; the backorder it left empty says it was cancelled.
    expect(odoo.pickings.get(700)?.notas).toEqual([
      'Se pasaron 1 paquete(s) a ARCTIC (MB92/OUT/00800) vía Webapp Paquetería por Veronika: QA-DHL-002',
    ])
    expect(odoo.pickings.get(701)?.notas).toEqual([
      'La entrega quedó vacía al pasar sus paquetes a ARCTIC y se canceló (vía Webapp Paquetería por Veronika).',
    ])
  })

  it('writes nothing in Odoo, and leaves the sesión as it was, for a package that is not waiting any more', async () => {
    odooConEntregas({ conEntregaDeArctic: true })
    odoo.pickings.get(700)!.cerrado = 'done'
    const sesion = await crearReasignacion([1])

    const error = await syncReasignacionSession(sesion.id).catch((fallo: unknown) => fallo)

    expect(error).toBeInstanceOf(RespuestaOdooInesperadaError)
    expect(clasificarError(error)).toBe('odoo')
    expect(odoo.escriturasHechas()).toEqual([])
    expect(await filaSesion(sesion.id)).toMatchObject({ estado: 'confirmada_pendiente_sync', odooPickingId: null })
  })

  it('asks nothing of Odoo when the almacén has no delivery type: that is for the admin', async () => {
    odooConEntregas({ conEntregaDeArctic: true })
    const sinTipo = await seedAlmacen(db, { prefijo: 'TGN', nombre: 'Tarragona', odooWarehouseId: 4, odooInTypeId: 25, odooOutTypeId: null })
    const sesion = await crearReasignacion([1], { almacenId: sinTipo.id })

    await expect(syncReasignacionSession(sesion.id)).rejects.toThrow(ConfiguracionError)
    expect(odooCall).not.toHaveBeenCalled()
  })

  it.each(['en_curso', 'sincronizada', 'error'] as const)('does nothing for a reasignación that is %s', async (estado) => {
    odooConEntregas({ conEntregaDeArctic: true })
    const sesion = await crearReasignacion([1], { estado })

    await syncReasignacionSession(sesion.id)

    expect(odooCall).not.toHaveBeenCalled()
    expect((await filaSesion(sesion.id)).estado).toBe(estado)
  })

  it('throws for a sesión that does not exist', async () => {
    await expect(syncReasignacionSession('00000000-0000-4000-8000-000000000000')).rejects.toThrow('no encontrada')
  })
})
