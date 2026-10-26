import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))

import { db } from '@/db/client'
import { courierUso, type Almacen, type Courier } from '@/db/schema'
import { seedAlmacen, seedCourier } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { COURIERS_FRECUENTES, getCouriersParaRecepcion } from './couriers'

let mb92: Almacen
let mad1: Almacen
let producto = 0

beforeEach(async () => {
  await resetTestDb(db as unknown as TestDb)
  producto = 0
  mb92 = await seedAlmacen(db)
  mad1 = await seedAlmacen(db, { prefijo: 'MAD1', nombre: 'Madrid (MAD1)', odooWarehouseId: 2, odooInTypeId: 3, odooOutTypeId: 4 })
})

/** A courier with its own Odoo product, and the times it was used in each almacén. */
async function courier(nombre: string, usos: { mb92?: number; mad1?: number } = {}, datos: Partial<Courier> = {}): Promise<Courier> {
  producto += 1
  const creado = await seedCourier(db, { nombre, odooProductId: producto, ...datos })
  if (usos.mb92 !== undefined) await db.insert(courierUso).values({ almacenId: mb92.id, courierId: creado.id, usos: usos.mb92 })
  if (usos.mad1 !== undefined) await db.insert(courierUso).values({ almacenId: mad1.id, courierId: creado.id, usos: usos.mad1 })
  return creado
}

const nombres = (opciones: Array<{ nombre: string }>) => opciones.map((opcion) => opcion.nombre)

describe('getCouriersParaRecepcion', () => {
  it('shows the ten most used as the frequent ones', () => {
    expect(COURIERS_FRECUENTES).toBe(10)
  })

  it('frecuentes are the most used couriers of the almacén, inactive ones excluded', async () => {
    await courier('DHL', { mb92: 40 })
    await courier('UPS', { mb92: 30 })
    await courier('GLS', { mb92: 25 })
    await courier('SEUR', { mb92: 20 })
    await courier('FedEx', { mb92: 18 })
    await courier('Correos', { mb92: 15 })
    await courier('Amazon', { mb92: 12 })
    await courier('MRW', { mb92: 9 })
    await courier('PAACK', { mb92: 7 })
    await courier('Chronopost', { mb92: 5 })
    await courier('Nacex', { mb92: 3 })
    await courier('DPD', { mb92: 2 })
    // The most used of all, but Odoo no longer has it.
    await courier('UPS (incorrecto)', { mb92: 100 }, { activo: false })

    const { frecuentes, todos } = await getCouriersParaRecepcion(mb92.id)

    expect(nombres(frecuentes)).toEqual(['DHL', 'UPS', 'GLS', 'SEUR', 'FedEx', 'Correos', 'Amazon', 'MRW', 'PAACK', 'Chronopost'])
    expect(nombres(todos)).not.toContain('UPS (incorrecto)')
    expect(todos).toHaveLength(12)
  })

  it('counts only the use in that almacén', async () => {
    await courier('DHL', { mb92: 50, mad1: 1 })
    await courier('UPS', { mb92: 1, mad1: 50 })
    for (let i = 0; i < 10; i++) await courier(`Otro ${String(i).padStart(2, '0')}`, { mb92: 10 - i, mad1: 10 - i })

    const enMb92 = await getCouriersParaRecepcion(mb92.id)
    const enMad1 = await getCouriersParaRecepcion(mad1.id)

    expect(nombres(enMb92.frecuentes).slice(0, 2)).toEqual(['DHL', 'Otro 00'])
    expect(nombres(enMb92.frecuentes)).not.toContain('UPS')
    expect(nombres(enMad1.frecuentes).slice(0, 2)).toEqual(['UPS', 'Otro 00'])
    expect(nombres(enMad1.frecuentes)).not.toContain('DHL')
  })

  it('falls back to the first ten by name when there is no usage yet', async () => {
    for (const nombre of ['Zeleris', 'UPS', 'SEUR', 'Royal Mail', 'PAACK', 'MRW', 'GLS', 'FedEx', 'DHL', 'Correos', 'Chronopost', 'Amazon']) {
      await courier(nombre)
    }

    const { frecuentes, todos } = await getCouriersParaRecepcion(mb92.id)

    expect(nombres(frecuentes)).toEqual(['Amazon', 'Chronopost', 'Correos', 'DHL', 'FedEx', 'GLS', 'MRW', 'PAACK', 'Royal Mail', 'SEUR'])
    expect(todos).toHaveLength(12)
  })

  it('falls back the same way when the usage rows exist but all say zero', async () => {
    await courier('UPS', { mb92: 0 })
    await courier('DHL', { mb92: 0 })
    await courier('Amazon', { mb92: 0 })

    const { frecuentes } = await getCouriersParaRecepcion(mb92.id)

    expect(nombres(frecuentes)).toEqual(['Amazon', 'DHL', 'UPS'])
  })

  it('puts the used couriers first and fills the rest of the ten with the first ones by name', async () => {
    await courier('Zeleris', { mb92: 4 })
    await courier('UPS', { mb92: 9 })
    for (let i = 0; i < 12; i++) await courier(`Courier ${String(i).padStart(2, '0')}`)

    const { frecuentes } = await getCouriersParaRecepcion(mb92.id)

    expect(nombres(frecuentes)).toEqual([
      'UPS', 'Zeleris',
      'Courier 00', 'Courier 01', 'Courier 02', 'Courier 03', 'Courier 04', 'Courier 05', 'Courier 06', 'Courier 07',
    ])
  })

  it('breaks a tie of use by name, so the chips come in the same order every time', async () => {
    await courier('SEUR', { mb92: 5 })
    await courier('GLS', { mb92: 5 })
    await courier('DHL', { mb92: 5 })

    const { frecuentes } = await getCouriersParaRecepcion(mb92.id)

    expect(nombres(frecuentes)).toEqual(['DHL', 'GLS', 'SEUR'])
  })

  it('gives all of the active couriers, ordered by name whatever the case or the accents', async () => {
    await courier('seur')
    await courier('Zeleris')
    await courier('BPOST')
    await courier('dhl')
    await courier('Ángel Express')
    await courier('Amazon')

    const { todos } = await getCouriersParaRecepcion(mb92.id)

    expect(nombres(todos)).toEqual(['Amazon', 'Ángel Express', 'BPOST', 'dhl', 'seur', 'Zeleris'])
  })

  it('keeps two couriers with the same name apart, in a fixed order (Odoo has two "DHL" products)', async () => {
    const primero = await courier('DHL')
    const segundo = await courier('DHL')

    const { todos } = await getCouriersParaRecepcion(mb92.id)

    expect(todos.map((opcion) => opcion.id)).toEqual([primero.id, segundo.id])
  })

  it('has every frequent courier among all of them', async () => {
    for (let i = 0; i < 15; i++) await courier(`Courier ${String(i).padStart(2, '0')}`, { mb92: i })

    const { frecuentes, todos } = await getCouriersParaRecepcion(mb92.id)

    expect(frecuentes).toHaveLength(COURIERS_FRECUENTES)
    for (const opcion of frecuentes) expect(todos).toContainEqual(opcion)
  })

  it('gives just the id and the name of each courier, the way the screen takes them', async () => {
    const dhl = await courier('DHL', { mb92: 3 })

    expect(await getCouriersParaRecepcion(mb92.id)).toEqual({
      frecuentes: [{ id: dhl.id, nombre: 'DHL' }],
      todos: [{ id: dhl.id, nombre: 'DHL' }],
    })
  })

  it('has nothing to offer when there is no active courier', async () => {
    await courier('UPS (incorrecto)', { mb92: 5 }, { activo: false })

    expect(await getCouriersParaRecepcion(mb92.id)).toEqual({ frecuentes: [], todos: [] })
  })

  it('still gives the couriers for an almacén that has no usage at all', async () => {
    await courier('DHL', { mb92: 3 })
    await courier('GLS')

    const { frecuentes, todos } = await getCouriersParaRecepcion(mad1.id)

    expect(nombres(frecuentes)).toEqual(['DHL', 'GLS'])
    expect(nombres(todos)).toEqual(['DHL', 'GLS'])
  })
})
