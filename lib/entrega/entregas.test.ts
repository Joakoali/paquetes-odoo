import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
// The Odoo read is mocked whole: these tests never reach Odoo. Publishing and auditing are mocked
// because recepciones.ts imports them, and nothing here sends a recepción.
vi.mock('@/lib/odoo/pickings', () => ({ getBarcosConEntregaPendiente: vi.fn() }))
vi.mock('@/lib/queue/publish', () => ({ publishSync: vi.fn() }))
vi.mock('@/lib/audit', () => ({ registrarAuditoria: vi.fn() }))

import { db } from '@/db/client'
import type { Almacen, Courier, Operario } from '@/db/schema'
import { ConfiguracionError } from '@/lib/errores'
import { getBarcosConEntregaPendiente, type BarcoConEntrega } from '@/lib/odoo/pickings'
import { abrirRecepcion, escanearPaquete } from '@/lib/recepcion/recepciones'
import { seedAlmacen, seedBarco, seedCourier, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { listarBarcosParaEntregar } from './entregas'

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
