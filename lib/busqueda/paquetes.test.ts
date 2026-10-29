import { beforeEach, describe, expect, it, vi } from 'vitest'

// The database is the real thing, in memory. Odoo is not: what it answers is set by each test.
vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('@/lib/odoo/busqueda', () => ({ buscarEnOdoo: vi.fn() }))

import { db } from '@/db/client'
import {
  sesionCourierBatches, sesionItems, sesionesEscaneo,
  type Almacen, type Courier, type Operario, type PaqueteEntregado,
} from '@/db/schema'
import { ConfiguracionError, OdooError } from '@/lib/errores'
import { buscarEnOdoo, type LineaEncontradaEnOdoo } from '@/lib/odoo/busqueda'
import { seedAlmacen, seedBarco, seedCourier, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { LECTURA_DE_ODOO_FALLIDA } from '@/lib/ui/lectura-fallida'
import { buscarPaquetes, LIMITE_PAQUETES, LIMITE_POR_FUENTE } from './paquetes'

const hace = (horas: number) => new Date(Date.now() - horas * 3_600_000)

let veronika: Operario
let eduardo: Operario
let mb92: Almacen
let ibz: Almacen
let dhl: Courier

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  veronika = await seedOperario(db, { nombre: 'Veronika' })
  eduardo = await seedOperario(db, { nombre: 'Eduardo' })
  mb92 = await seedAlmacen(db) // in type 1, out type 2
  ibz = await seedAlmacen(db, { prefijo: 'IBZ', nombre: 'Ibiza - Baleares', odooWarehouseId: 7, odooInTypeId: 49, odooOutTypeId: 50 })
  dhl = await seedCourier(db)
  await seedBarco(db) // 673 MAYANQUEEN
  await seedBarco(db, { odooId: 935, nombre: 'H3' })
  vi.mocked(buscarEnOdoo).mockResolvedValue([])
})

/** A recepción with these packages, scanned in this order, written straight to the database in any estado. */
async function recepcion(
  paquetes: Array<{ trackingNumber: string; estado?: 'ok' | 'duplicado' | 'sincronizado'; duplicadoRef?: string; escaneadoAt?: Date }>,
  datos: Partial<typeof sesionesEscaneo.$inferInsert> = {},
) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: veronika.id, almacenId: mb92.id, barcoOdooId: 673, tipo: 'recepcion', estado: 'en_curso', ...datos,
  }).returning()
  const [tanda] = await db.insert(sesionCourierBatches).values({ sesionId: sesion.id, courierId: dhl.id }).returning()
  for (const paquete of paquetes) {
    await db.insert(sesionItems).values({
      courierBatchId: tanda.id,
      trackingNumber: paquete.trackingNumber,
      estado: paquete.estado ?? 'ok',
      duplicadoRef: paquete.duplicadoRef ?? null,
      operarioId: veronika.id,
      createdAt: paquete.escaneadoAt ?? new Date(),
    })
  }
  return sesion
}

/** An entrega that handed these packages over, written straight to the database. */
async function entrega(paquetes: PaqueteEntregado[], datos: Partial<typeof sesionesEscaneo.$inferInsert> = {}) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: eduardo.id,
    almacenId: mb92.id,
    barcoOdooId: 673,
    tipo: 'entrega',
    estado: 'confirmada_pendiente_sync',
    odooPickingIds: [700],
    odooMoveLineIds: paquetes.map((_, posicion) => posicion + 1),
    paquetesEntrega: paquetes,
    receptorNombre: 'Tom Baker',
    firmaData: 'AAA',
    confirmedAt: new Date(),
    ...datos,
  }).returning()
  return sesion
}

/** A line of Odoo, as `buscarEnOdoo` gives it. */
const enOdoo = (datos: Partial<LineaEncontradaEnOdoo>): LineaEncontradaEnOdoo => ({
  trackingNumber: 'JJD000390007840588',
  courierNombre: 'DHL',
  pickingId: 5,
  pickingRef: 'MB92/IN/00231',
  pickingTypeId: 1,
  operacion: 'recepcion',
  hecho: true,
  barco: { odooId: 673, nombre: 'MAYANQUEEN' },
  fecha: hace(20),
  recibidoPor: 'Veronika',
  ...datos,
})

const paqueteDe = (tracking: string) => ({ trackingNumber: tracking, courierNombre: 'DHL', pickingRef: 'MB92/OUT/00487' })

describe('buscarPaquetes', () => {
  describe('in the recepciones of the webapp', () => {
    it('finds a package by a part of its number, whatever the case and the blanks', async () => {
      const abierta = await recepcion([{ trackingNumber: 'JJD000390007840588' }, { trackingNumber: 'XW297134737JF' }])

      for (const buscado of ['0588', 'jjd0003', 'JJD 0003 9000']) {
        const { paquetes } = await buscarPaquetes(buscado)

        expect(paquetes.map((paquete) => paquete.trackingNumber)).toEqual(['JJD000390007840588'])
        expect(paquetes[0].lugares).toEqual([expect.objectContaining({ tipo: 'recepcion', sesionId: abierta.id })])
      }
    })

    it('says of each package where its recepción is, who scanned it and how its sending is going', async () => {
      const enviada = await recepcion([{ trackingNumber: 'JJD000390007840588', estado: 'sincronizado' }], {
        estado: 'sincronizada', odooPickingRef: 'MB92/IN/00231', confirmedAt: hace(1),
      })

      const { paquetes: [paquete] } = await buscarPaquetes('0588')

      expect(paquete).toMatchObject({ trackingNumber: 'JJD000390007840588', courierNombre: 'DHL' })
      expect(paquete.lugares).toEqual([{
        tipo: 'recepcion',
        trackingNumber: 'JJD000390007840588',
        almacenId: mb92.id,
        almacenPrefijo: 'MB92',
        barcoOdooId: 673,
        barcoNombre: 'MAYANQUEEN',
        fecha: expect.any(Date),
        sesionId: enviada.id,
        estado: 'ok',
        odooPickingRef: 'MB92/IN/00231',
        operarioNombre: 'Veronika',
        duplicado: false,
        duplicadoRef: null,
      }])
    })

    it.each([
      ['en_curso', null, 'abierta'],
      ['confirmada_pendiente_sync', null, 'enviando'],
      ['sincronizada', null, 'ok'],
      ['sincronizada', 'Todos los tracking numbers eran duplicados', 'problema'],
      ['error', 'Odoo HTTP 422', 'problema'],
    ] as const)('tells a recepción that is %s (note: %s) as %s', async (estado, ultimoError, esperado) => {
      await recepcion([{ trackingNumber: 'JJD000390007840588' }], { estado, ultimoError })

      const { paquetes: [paquete] } = await buscarPaquetes('0588')

      expect(paquete.lugares[0]).toMatchObject({ tipo: 'recepcion', estado: esperado })
    })

    it('tells a package that was not sent because Odoo already had it, and where', async () => {
      await recepcion([{ trackingNumber: 'JJD000390007840588', estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' }], {
        estado: 'sincronizada', odooPickingRef: 'MB92/IN/00231',
      })

      const { paquetes: [paquete] } = await buscarPaquetes('0588')

      expect(paquete.lugares[0]).toMatchObject({ duplicado: true, duplicadoRef: 'MB92/IN/00198' })
    })

    it('names a barco the cache does not know as the lists do', async () => {
      await recepcion([{ trackingNumber: 'JJD000390007840588' }], { barcoOdooId: 4242 })

      const { paquetes: [paquete] } = await buscarPaquetes('0588')

      expect(paquete.lugares[0]).toMatchObject({ barcoOdooId: 4242, barcoNombre: 'Barco #4242' })
    })

    it('finds them in every almacén, saying which: what may be opened is decided by the screen', async () => {
      await recepcion([{ trackingNumber: 'JJD000390007840588' }], { almacenId: ibz.id })

      const { paquetes: [paquete] } = await buscarPaquetes('0588')

      expect(paquete.lugares[0]).toMatchObject({ almacenId: ibz.id, almacenPrefijo: 'IBZ' })
    })

    it('takes what was typed as text: % and _ are not wildcards', async () => {
      await recepcion([{ trackingNumber: 'JJD000390007840588' }, { trackingNumber: 'AB%_\\1234' }])

      expect((await buscarPaquetes('%%%%')).paquetes).toEqual([])
      expect((await buscarPaquetes('____')).paquetes).toEqual([])
      expect((await buscarPaquetes('%_\\1')).paquetes.map((paquete) => paquete.trackingNumber)).toEqual(['AB%_\\1234'])
    })
  })

  describe('in the entregas of the webapp', () => {
    it('finds the packages an entrega handed over, and only those that have what was searched', async () => {
      const hecha = await entrega([paqueteDe('JJD000390007840588'), paqueteDe('XW297134737JF'), { ...paqueteDe('x'), trackingNumber: null }])

      const { paquetes } = await buscarPaquetes('0588')

      expect(paquetes).toHaveLength(1)
      expect(paquetes[0].lugares).toEqual([{
        tipo: 'entrega',
        trackingNumber: 'JJD000390007840588',
        almacenId: mb92.id,
        almacenPrefijo: 'MB92',
        barcoOdooId: 673,
        barcoNombre: 'MAYANQUEEN',
        fecha: expect.any(Date),
        sesionId: hecha.id,
        estado: 'enviando',
        pickingRef: 'MB92/OUT/00487',
        receptorNombre: 'Tom Baker',
      }])
    })

    it('finds nothing in an entrega confirmed before the entregas kept their packages', async () => {
      await entrega([], { paquetesEntrega: null })

      expect((await buscarPaquetes('0588')).paquetes).toEqual([])
    })
  })

  describe('in Odoo', () => {
    it('asks Odoo with what was searched, normalized, and one line more than it shows', async () => {
      await buscarPaquetes(' JJD 0588 ')

      expect(buscarEnOdoo).toHaveBeenCalledWith({ buscado: 'jjd0588', limite: LIMITE_POR_FUENTE + 1 })
    })

    it('tells each picking with its almacén, by its operation type, and its barco', async () => {
      vi.mocked(buscarEnOdoo).mockResolvedValue([
        enOdoo({ pickingTypeId: 1 }),
        enOdoo({ pickingId: 9, pickingRef: 'IBZ/OUT/00012', pickingTypeId: 50, operacion: 'entrega', hecho: false, fecha: hace(10), recibidoPor: null }),
      ])

      const { paquetes: [paquete] } = await buscarPaquetes('0588')

      expect(paquete.lugares).toEqual([
        {
          tipo: 'odoo', trackingNumber: 'JJD000390007840588', almacenId: mb92.id, almacenPrefijo: 'MB92', barcoOdooId: 673,
          barcoNombre: 'MAYANQUEEN', fecha: expect.any(Date), operacion: 'recepcion', hecho: true, pickingRef: 'MB92/IN/00231',
          recibidoPor: 'Veronika',
        },
        expect.objectContaining({ almacenId: ibz.id, almacenPrefijo: 'IBZ', operacion: 'entrega', hecho: false, pickingRef: 'IBZ/OUT/00012' }),
      ])
    })

    it('does not know the almacén of an operation type the app does not have, nor the barco of a picking without one', async () => {
      vi.mocked(buscarEnOdoo).mockResolvedValue([enOdoo({ pickingTypeId: 999, barco: null }), enOdoo({ pickingId: 6, pickingRef: 'X', pickingTypeId: null })])

      const { paquetes: [paquete] } = await buscarPaquetes('0588')

      expect(paquete.lugares[0]).toMatchObject({ almacenId: null, almacenPrefijo: null, barcoOdooId: null, barcoNombre: null })
      expect(paquete.lugares[1]).toMatchObject({ almacenId: null, almacenPrefijo: null })
    })

    it('still gives what the webapp has when Odoo cannot be read, and says so', async () => {
      await recepcion([{ trackingNumber: 'JJD000390007840588' }])
      vi.mocked(buscarEnOdoo).mockRejectedValue(new OdooError({ status: 502, data: 'Bad Gateway' }))

      const busqueda = await buscarPaquetes('0588')

      expect(busqueda.odooFallo).toBe(LECTURA_DE_ODOO_FALLIDA)
      expect(busqueda.paquetes).toHaveLength(1)
    })

    it('says what an admin has to set up when that is why', async () => {
      vi.mocked(buscarEnOdoo).mockRejectedValue(new ConfiguracionError('ODOO_FIELD_BARCO no está configurado'))

      expect((await buscarPaquetes('0588')).odooFallo).toBe('ODOO_FIELD_BARCO no está configurado')
    })

    it('does not tell a failure of the database as one of Odoo: the almacenes of the pickings are read from it', async () => {
      vi.mocked(buscarEnOdoo).mockResolvedValue([enOdoo({})])
      const select = db.select.bind(db)
      vi.spyOn(db, 'select').mockImplementation(((campos?: Record<string, unknown>) => {
        // Only the read of the almacenes by operation type, which goes with the reading of Odoo, fails, as neon-http
        // fails when it cannot reach the database: with the same error a fetch to Odoo gives.
        if (campos && 'inTypeId' in campos) throw new TypeError('fetch failed')
        return select(campos as never)
      }) as typeof db.select)

      await expect(buscarPaquetes('0588')).rejects.toThrow('fetch failed')
    })

    it('does not hide a bug behind "Odoo could not be read"', async () => {
      vi.mocked(buscarEnOdoo).mockRejectedValue(new TypeError('Cannot read properties of undefined'))

      await expect(buscarPaquetes('0588')).rejects.toThrow(TypeError)
    })
  })

  describe('a package found in more than one place', () => {
    it('is told once, with its places in the order they happened', async () => {
      await recepcion([{ trackingNumber: 'JJD000390007840588', estado: 'sincronizado', escaneadoAt: hace(30) }], {
        estado: 'sincronizada', odooPickingRef: 'MB92/IN/00231',
      })
      await entrega([paqueteDe('JJD000390007840588')], { confirmedAt: hace(2) })
      vi.mocked(buscarEnOdoo).mockResolvedValue([
        enOdoo({ pickingRef: 'MB92/IN/00231', fecha: hace(29) }),
        enOdoo({ pickingId: 9, pickingRef: 'MB92/OUT/00487', pickingTypeId: 2, operacion: 'entrega', hecho: false, fecha: hace(28) }),
      ])

      const { paquetes } = await buscarPaquetes('0588')

      expect(paquetes).toHaveLength(1)
      // The picking of the recepción and the delivery of the entrega are the webapp's places already: Odoo says less of
      // them (while the entrega is on its way, Odoo still lists the package as waiting), so they are not told twice.
      expect(paquetes[0].lugares.map((lugar) => lugar.tipo)).toEqual(['recepcion', 'entrega'])
    })

    it('keeps the picking of Odoo that a place of the webapp is not: a reception made by hand, a delivery still waiting', async () => {
      await recepcion([{ trackingNumber: 'JJD000390007840588', estado: 'duplicado', duplicadoRef: 'MB92/IN/00198', escaneadoAt: hace(1) }], {
        estado: 'sincronizada', odooPickingRef: 'MB92/IN/00231',
      })
      vi.mocked(buscarEnOdoo).mockResolvedValue([
        enOdoo({ pickingRef: 'MB92/IN/00198', fecha: hace(40) }),
        enOdoo({ pickingId: 9, pickingRef: 'MB92/OUT/00487', pickingTypeId: 2, operacion: 'entrega', hecho: false, fecha: hace(39) }),
      ])

      const { paquetes: [paquete] } = await buscarPaquetes('0588')

      expect(paquete.lugares.map((lugar) => [lugar.tipo, 'pickingRef' in lugar ? lugar.pickingRef : lugar.odooPickingRef])).toEqual([
        ['odoo', 'MB92/IN/00198'],
        ['odoo', 'MB92/OUT/00487'],
        // A duplicado stands for no picking: what it was sent with does not have it.
        ['recepcion', 'MB92/IN/00231'],
      ])
    })

    it('is the same package whatever the case each place writes it with', async () => {
      await recepcion([{ trackingNumber: 'jjd000390007840588' }])
      vi.mocked(buscarEnOdoo).mockResolvedValue([enOdoo({ trackingNumber: 'JJD000390007840588' })])

      const { paquetes } = await buscarPaquetes('0588')

      expect(paquetes).toHaveLength(1)
      expect(paquetes[0].lugares).toHaveLength(2)
    })
  })

  describe('the order and the limits', () => {
    it('puts the package whose number is exactly what was searched first, then the newest news', async () => {
      await recepcion([
        { trackingNumber: 'AAAA0588', escaneadoAt: hace(5) },
        { trackingNumber: 'BBBB0588', escaneadoAt: hace(1) },
        { trackingNumber: '0588', escaneadoAt: hace(50) },
      ])

      const { paquetes } = await buscarPaquetes('0588')

      expect(paquetes.map((paquete) => paquete.trackingNumber)).toEqual(['0588', 'BBBB0588', 'AAAA0588'])
    })

    it(`shows at most ${LIMITE_PAQUETES} packages, and says there are more`, async () => {
      await recepcion(Array.from({ length: LIMITE_PAQUETES + 1 }, (_, posicion) => ({ trackingNumber: `JJD0588-${posicion}` })))

      const busqueda = await buscarPaquetes('0588')

      expect(busqueda.paquetes).toHaveLength(LIMITE_PAQUETES)
      expect(busqueda.hayMas).toBe(true)
    })

    it('says there are more when Odoo had more lines than it gave', async () => {
      vi.mocked(buscarEnOdoo).mockResolvedValue(
        Array.from({ length: LIMITE_POR_FUENTE + 1 }, (_, posicion) => enOdoo({ pickingId: posicion, pickingRef: `MB92/IN/${posicion}` })),
      )

      const busqueda = await buscarPaquetes('0588')

      expect(busqueda.hayMas).toBe(true)
      expect(busqueda.paquetes[0].lugares).toHaveLength(LIMITE_POR_FUENTE)
    })

    it('says nothing more of a search that found all there was', async () => {
      await recepcion([{ trackingNumber: 'JJD000390007840588' }])

      expect(await buscarPaquetes('0588')).toEqual(expect.objectContaining({ hayMas: false, odooFallo: null }))
    })

    it('reads nothing for less than four characters, blanks aside', async () => {
      await recepcion([{ trackingNumber: 'JJD000390007840588' }])

      expect(await buscarPaquetes(' 0 5 8 ')).toEqual({ paquetes: [], hayMas: false, odooFallo: null })
      expect(buscarEnOdoo).not.toHaveBeenCalled()
    })
  })
})
