import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('next/navigation', () => ({ notFound: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireAdminFromCookies: vi.fn() }))
vi.mock('./actions', () => ({ updateAlmacenesAction: vi.fn() }))

import { eq } from 'drizzle-orm'
import { renderToStaticMarkup } from 'react-dom/server'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { almacenes, type Almacen, type Operario } from '@/db/schema'
import { setAlmacenesForOperario } from '@/lib/admin/operarioAlmacenes'
import { ForbiddenError } from '@/lib/auth/guards'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { seedAlmacen, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import OperarioAlmacenesPage from './page'

let admin: Operario
let operario: Operario
let mb92: Almacen
let mpv: Almacen
let mlc: Almacen

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  admin = await seedOperario(db, { nombre: 'Joaquín', rol: 'admin' })
  operario = await seedOperario(db, { nombre: 'Veronika' })
  mb92 = await seedAlmacen(db, { nombre: 'MB92 - Barcelona' })
  mpv = await seedAlmacen(db, { prefijo: 'MPV', nombre: 'MPV - Port Vell', odooWarehouseId: 2 })
  // An almacén that Odoo no longer has, and that the operario still has assigned.
  mlc = await seedAlmacen(db, { prefijo: 'MLC', nombre: 'MLC - Mallorca', odooWarehouseId: 3 })
  await setAlmacenesForOperario(operario.id, [mb92.id, mlc.id])
  await db.update(almacenes).set({ activo: false }).where(eq(almacenes.id, mlc.id))
  vi.mocked(requireAdminFromCookies).mockResolvedValue(admin)
  vi.mocked(notFound).mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND')
  })
})

/** The page as the browser will be given it, as HTML. */
const html = async (id: string) => renderToStaticMarkup(await OperarioAlmacenesPage({ params: Promise.resolve({ id }) }))

describe('OperarioAlmacenesPage', () => {
  it('lists the active almacenes only, and says whose they are', async () => {
    const pagina = await html(operario.id)

    expect(pagina).toContain('Almacenes de Veronika')
    expect(pagina).toContain('MB92 - Barcelona')
    expect(pagina).toContain('MPV - Port Vell')
    expect(pagina).not.toContain('MLC')
  })

  it('ticks the almacenes the operario has and only those', async () => {
    const pagina = await html(operario.id)

    const casillas = pagina.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []
    expect(casillas).toHaveLength(2)
    expect(casillas.find((c) => c.includes(`value="${mb92.id}"`))).toContain('checked')
    expect(casillas.find((c) => c.includes(`value="${mpv.id}"`))).not.toContain('checked')
  })

  it('says there is nothing to choose when no almacén is active', async () => {
    await db.update(almacenes).set({ activo: false })

    const pagina = await html(operario.id)

    expect(pagina).toContain('No hay almacenes activos')
    expect(pagina).not.toContain('type="checkbox"')
  })

  it.each([
    ['an id that names nobody', '00000000-0000-4000-8000-000000000000'],
    ['something that is not an id', 'no-es-un-id'],
  ])('is not found for %s', async (_que, id) => {
    await expect(html(id)).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFound).toHaveBeenCalledTimes(1)
  })

  it('shows nothing to whoever is not an admin', async () => {
    vi.mocked(requireAdminFromCookies).mockRejectedValue(new ForbiddenError('Admin role required'))

    await expect(html(operario.id)).rejects.toBeInstanceOf(ForbiddenError)
  })
})
