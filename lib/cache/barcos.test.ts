import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))

import { db } from '@/db/client'
import { barcosCache } from '@/db/schema'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import { seedBarco } from '@/lib/testing/seed'
import { barcoActivo, BUSQUEDA_BARCOS_LIMITE, searchBarcos } from './barcos'

beforeEach(() => resetTestDb(db as unknown as TestDb))

const nombres = (barcos: Array<{ nombre: string }>) => barcos.map((b) => b.nombre)

describe('searchBarcos', () => {
  it('returns only active barcos, ordered by name, at most 20', async () => {
    const todos = Array.from({ length: 25 }, (_, i) => `BARCO ${String(i + 1).padStart(2, '0')}`)
    // Inserted from the last to the first, so the order cannot come from the insertion order.
    await db.insert(barcosCache).values([...todos].reverse().map((nombre, i) => ({ odooId: 100 + i, nombre })))
    await seedBarco(db, { odooId: 999, nombre: 'BARCO 00 (ARCHIVADO)', activo: false })

    const resultado = await searchBarcos('barco')

    expect(BUSQUEDA_BARCOS_LIMITE).toBe(20)
    expect(resultado).toHaveLength(20)
    expect(nombres(resultado)).toEqual(todos.slice(0, 20))
  })

  it('does not return a barco that is no longer in Odoo', async () => {
    await seedBarco(db, { odooId: 1, nombre: 'MOONSHADOW' })
    await seedBarco(db, { odooId: 2, nombre: 'MOONLIGHT', activo: false })

    expect(nombres(await searchBarcos('moon'))).toEqual(['MOONSHADOW'])
  })

  it('orders by name ignoring case', async () => {
    await seedBarco(db, { odooId: 1, nombre: 'zeta' })
    await seedBarco(db, { odooId: 2, nombre: 'Alfa' })
    await seedBarco(db, { odooId: 3, nombre: 'MIKE' })
    await seedBarco(db, { odooId: 4, nombre: 'bravo' })

    expect(nombres(await searchBarcos(''))).toEqual(['Alfa', 'bravo', 'MIKE', 'zeta'])
  })

  it('finds the text anywhere in the name, whatever its case', async () => {
    await seedBarco(db, { odooId: 1, nombre: 'MOONSHADOW' })
    await seedBarco(db, { odooId: 2, nombre: 'BLUE MOON' })
    await seedBarco(db, { odooId: 3, nombre: 'SUNSET' })

    expect(nombres(await searchBarcos('moon'))).toEqual(['BLUE MOON', 'MOONSHADOW'])
    expect(await searchBarcos('xyz')).toEqual([])
  })

  it('treats % and _ in the query literally', async () => {
    await seedBarco(db, { odooId: 1, nombre: 'AB_CD' })
    await seedBarco(db, { odooId: 2, nombre: 'ABXCD' })
    await seedBarco(db, { odooId: 3, nombre: '50% OFF' })
    await seedBarco(db, { odooId: 4, nombre: '500 OFF' })
    await seedBarco(db, { odooId: 5, nombre: 'BACK\\SLASH' })
    await seedBarco(db, { odooId: 6, nombre: 'BACKSLASH' })

    expect(nombres(await searchBarcos('b_c'))).toEqual(['AB_CD'])
    expect(nombres(await searchBarcos('%'))).toEqual(['50% OFF'])
    expect(nombres(await searchBarcos('0%'))).toEqual(['50% OFF'])
    expect(nombres(await searchBarcos('K\\S'))).toEqual(['BACK\\SLASH'])
    expect(nombres(await searchBarcos('\\'))).toEqual(['BACK\\SLASH']) // a lone backslash must not break the pattern
  })

  it('labels same-named active barcos with their Odoo id', async () => {
    await seedBarco(db, { odooId: 942, nombre: 'H3' })
    await seedBarco(db, { odooId: 943, nombre: 'H3' })

    expect((await searchBarcos('h3')).map((b) => b.etiqueta)).toEqual(['H3 · #942', 'H3 · #943'])
  })

  it('labels with the plain name the barcos whose name is not repeated in the result', async () => {
    await seedBarco(db, { odooId: 942, nombre: 'H3' })
    await seedBarco(db, { odooId: 943, nombre: 'H3' })
    await seedBarco(db, { odooId: 950, nombre: 'H30' })

    expect((await searchBarcos('h3')).map((b) => b.etiqueta)).toEqual(['H3 · #942', 'H3 · #943', 'H30'])
  })

  it('compares names ignoring case when deciding to label', async () => {
    await seedBarco(db, { odooId: 942, nombre: 'H3' })
    await seedBarco(db, { odooId: 943, nombre: 'h3' })

    expect((await searchBarcos('h3')).map((b) => b.etiqueta)).toEqual(['H3 · #942', 'h3 · #943'])
  })

  it('does not label a barco because of a same-named one that is inactive', async () => {
    await seedBarco(db, { odooId: 942, nombre: 'H3' })
    await seedBarco(db, { odooId: 943, nombre: 'H3', activo: false })

    expect(await searchBarcos('h3')).toEqual([{ odooId: 942, nombre: 'H3', etiqueta: 'H3' }])
  })
})

describe('barcoActivo', () => {
  it('is true for a barco the search offers, and false for one that is archived or that the cache does not know', async () => {
    await seedBarco(db, { odooId: 1, nombre: 'MOONSHADOW' })
    await seedBarco(db, { odooId: 2, nombre: 'MOONLIGHT', activo: false })

    expect(await barcoActivo(1)).toBe(true)
    expect(await barcoActivo(2)).toBe(false)
    expect(await barcoActivo(3)).toBe(false)
  })
})
