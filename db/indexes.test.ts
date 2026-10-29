import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { createTestDb } from '@/lib/testing/test-db'
import { sesionItems, sesionesEscaneo } from './schema'

/** Creating the database runs every migration; with the whole suite running at once that takes longer than the default 5 s. */
const TIEMPO_PARA_CREAR_LA_BASE = 30_000

/** The index definitions (`CREATE INDEX ...`) Postgres has on the table, as the migrations left them. */
async function indicesDe(tabla: string): Promise<string[]> {
  const db = await createTestDb()
  const { rows } = await db.$client.query<{ indexdef: string }>(
    'select indexdef from pg_indexes where schemaname = $1 and tablename = $2',
    ['public', tabla],
  )
  return rows.map((fila) => fila.indexdef)
}

describe('the indexes of sesion_items', () => {
  // The lookup that tells whether a code is already in a recepción that is not in Odoo yet asks for the
  // tracking number alone, once per scan. The only other index on the table starts with courier_batch_id,
  // which that lookup does not know, so without this one it reads the whole table on every scan.
  it('has one on the tracking number alone, in the database the migrations make', async () => {
    const definiciones = await indicesDe('sesion_items')

    expect(definiciones.some((definicion) => /USING btree \(tracking_number\)$/.test(definicion))).toBe(true)
  }, TIEMPO_PARA_CREAR_LA_BASE)

  it('has it in the schema too, so that the next migration generated from it does not drop it', () => {
    const { indexes } = getTableConfig(sesionItems)

    const columnasPorIndice = indexes.map((indice) => indice.config.columns.map((columna) => ('name' in columna ? columna.name : '')))
    expect(columnasPorIndice).toContainEqual(['tracking_number'])
  })

  // Pendientes asks for the packages left out when they were sent on every render of the app, for its tab: a handful,
  // which a partial index finds without reading the packages of every synced sesión.
  it('has a partial one on the courier batch of the packages left out when they were sent', async () => {
    const definiciones = await indicesDe('sesion_items')

    expect(definiciones.some((definicion) => /USING btree \(courier_batch_id\) WHERE duplicado_al_enviar$/.test(definicion))).toBe(true)
  }, TIEMPO_PARA_CREAR_LA_BASE)

  it('keeps the unique constraint of a package in its courier batch', async () => {
    const definiciones = await indicesDe('sesion_items')

    expect(definiciones.some((definicion) => /UNIQUE INDEX .* \(courier_batch_id, tracking_number\)$/.test(definicion))).toBe(true)
  }, TIEMPO_PARA_CREAR_LA_BASE)
})

describe('the indexes of sesiones_escaneo', () => {
  // Enviadas hoy and Entregadas hoy ask, on every render of their homes, for what an almacén sent since 00:00.
  it('has one on the almacén, the tipo and the moment of the send', async () => {
    const definiciones = await indicesDe('sesiones_escaneo')

    expect(definiciones.some((definicion) => /USING btree \(almacen_id, tipo, confirmed_at\)$/.test(definicion))).toBe(true)
  }, TIEMPO_PARA_CREAR_LA_BASE)

  // The entregas of a barco on their way to Odoo, which the delivery screens must not offer again: a handful at any time.
  it('has a partial one on the almacén and the barco of what is waiting for the worker', async () => {
    const definiciones = await indicesDe('sesiones_escaneo')

    expect(definiciones.some((definicion) =>
      /USING btree \(almacen_id, barco_odoo_id\) WHERE \(estado = 'confirmada_pendiente_sync'::estado_sesion\)$/.test(definicion),
    )).toBe(true)
  }, TIEMPO_PARA_CREAR_LA_BASE)

  it('has them in the schema too, so that the next migration generated from it does not drop them', () => {
    const { indexes } = getTableConfig(sesionesEscaneo)

    const columnasPorIndice = indexes.map((indice) => indice.config.columns.map((columna) => ('name' in columna ? columna.name : '')))
    expect(columnasPorIndice).toContainEqual(['almacen_id', 'tipo', 'confirmed_at'])
    expect(columnasPorIndice).toContainEqual(['almacen_id', 'barco_odoo_id'])
  })
})
