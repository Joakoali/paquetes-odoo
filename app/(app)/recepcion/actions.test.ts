import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/admin/operarioAlmacenes', () => ({ operarioHasAlmacen: vi.fn() }))
vi.mock('@/lib/almacen-activo', () => ({ requireAlmacenActivo: vi.fn() }))
// The domain is what the actions wrap, and it has its own tests: its functions are replaced, its error classes are not.
vi.mock('@/lib/recepcion/recepciones', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/recepcion/recepciones')>()),
  abrirRecepcion: vi.fn(),
  escanearPaquete: vi.fn(),
  borrarPaquete: vi.fn(),
  descartarRecepcion: vi.fn(),
  descartarSiVacia: vi.fn(),
  enviarRecepcion: vi.fn(),
  enviarRecepcionesAbiertas: vi.fn(),
}))

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import {
  sesionCourierBatches, sesionItems, sesionesEscaneo,
  type Almacen, type Courier, type Operario,
} from '@/db/schema'
import { operarioHasAlmacen } from '@/lib/admin/operarioAlmacenes'
import type { ResultadoAccion } from '@/lib/acciones'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { ErrorParaOperario } from '@/lib/errores'
import {
  abrirRecepcion, borrarPaquete, descartarRecepcion, descartarSiVacia, enviarRecepcion, enviarRecepcionesAbiertas,
  escanearPaquete, EscaneoInvalidoError, RecepcionCerradaError,
  type ResultadoEscaneo,
} from '@/lib/recepcion/recepciones'
import { seedAlmacen, seedCourier, seedOperario } from '@/lib/testing/seed'
import { resetTestDb, type TestDb } from '@/lib/testing/test-db'
import {
  abrirRecepcionAction, asignarYEscanearAction, borrarPaqueteAction, descartarRecepcionAction,
  descartarSiVaciaAction, enviarRecepcionAction, enviarTodasAction, escanearAction,
} from './actions'

const NO_EXISTE = '00000000-0000-4000-8000-000000000000'
const SIN_ACCESO = 'No tenés acceso a esto.'
const SESION_VENCIDA = 'Tu sesión venció. Volvé a entrar.'
const SIN_ALMACENES = 'No tenés almacenes asignados. Avisá al admin.'
const SIN_RECEPCION = 'La recepción no existe.'

const dominio = [
  abrirRecepcion, escanearPaquete, borrarPaquete, descartarRecepcion, descartarSiVacia, enviarRecepcion, enviarRecepcionesAbiertas,
]

let operario: Operario
/** The active almacén, and the only one the operario has. */
let mb92: Almacen
/** An almacén the operario does not have. */
let mad1: Almacen
let dhl: Courier

beforeEach(async () => {
  vi.resetAllMocks()
  await resetTestDb(db as unknown as TestDb)
  operario = await seedOperario(db)
  mb92 = await seedAlmacen(db)
  mad1 = await seedAlmacen(db, { prefijo: 'MAD1', nombre: 'Madrid (MAD1)', odooWarehouseId: 2, odooInTypeId: 3, odooOutTypeId: 4 })
  dhl = await seedCourier(db)
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(operario)
  vi.mocked(operarioHasAlmacen).mockImplementation(async (_operarioId, almacenId) => almacenId === mb92.id)
  vi.mocked(requireAlmacenActivo).mockResolvedValue(mb92)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A recepción written straight to the database: the actions read it to find out whose almacén it is. */
async function crearSesion(datos: Partial<typeof sesionesEscaneo.$inferInsert> = {}) {
  const [sesion] = await db.insert(sesionesEscaneo).values({
    operarioId: operario.id,
    almacenId: mb92.id,
    barcoOdooId: 673,
    tipo: 'recepcion',
    ...datos,
  }).returning()
  return sesion
}

/** A package in the recepción, in the courier batch of `courier`. */
async function crearPaquete(sesionId: string, trackingNumber = 'T1', courier: Courier = dhl) {
  const [tanda] = await db.insert(sesionCourierBatches).values({ sesionId, courierId: courier.id }).returning()
  const [item] = await db.insert(sesionItems)
    .values({ courierBatchId: tanda.id, trackingNumber, operarioId: operario.id })
    .returning()
  return item
}

const silenciarConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => {})

const noSeLlamoAlDominio = () => {
  for (const funcion of dominio) expect(funcion).not.toHaveBeenCalled()
}

type Llamada = (ids: { sesionId: string; itemId: string }) => Promise<ResultadoAccion<unknown>>

/** The actions that work on one recepción (or one of its packages), each with the domain function it ends in. */
const SOBRE_UNA_RECEPCION: Array<[nombre: string, llamar: Llamada, funcionDelDominio: () => unknown]> = [
  ['escanearAction', ({ sesionId }) => escanearAction({ sesionId, courierId: dhl.id, trackingNumber: 'T1' }), () => escanearPaquete],
  ['borrarPaqueteAction', ({ itemId }) => borrarPaqueteAction(itemId), () => borrarPaquete],
  ['enviarRecepcionAction', ({ sesionId }) => enviarRecepcionAction(sesionId), () => enviarRecepcion],
  ['descartarRecepcionAction', ({ sesionId }) => descartarRecepcionAction(sesionId), () => descartarRecepcion],
  ['descartarSiVaciaAction', ({ sesionId }) => descartarSiVaciaAction(sesionId), () => descartarSiVacia],
]

/** The actions that work in the active almacén. */
const EN_EL_ALMACEN_ACTIVO: Array<[nombre: string, llamar: () => Promise<ResultadoAccion<unknown>>]> = [
  ['abrirRecepcionAction', () => abrirRecepcionAction(673)],
  ['enviarTodasAction', () => enviarTodasAction()],
  ['asignarYEscanearAction', () => asignarYEscanearAction({ barcoOdooId: 673, courierId: dhl.id, trackingNumber: 'T1' })],
]

describe.each(SOBRE_UNA_RECEPCION)('%s: authentication and access', (_nombre, llamar) => {
  it('refuses a recepción of an almacén the operario does not have, and does nothing', async () => {
    const sesion = await crearSesion({ almacenId: mad1.id })
    const paquete = await crearPaquete(sesion.id)

    expect(await llamar({ sesionId: sesion.id, itemId: paquete.id })).toEqual({ ok: false, error: SIN_ACCESO })

    expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mad1.id)
    noSeLlamoAlDominio()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('answers with the expired-session message, and does nothing, when there is no session', async () => {
    const sesion = await crearSesion()
    const paquete = await crearPaquete(sesion.id)
    vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

    expect(await llamar({ sesionId: sesion.id, itemId: paquete.id })).toEqual({ ok: false, error: SESION_VENCIDA })

    expect(operarioHasAlmacen).not.toHaveBeenCalled()
    noSeLlamoAlDominio()
  })
})

describe.each(SOBRE_UNA_RECEPCION)('%s, for a recepción of another almacén that the operario also has', (_nombre, llamar, funcionDelDominio) => {
  it('checks the almacén of that recepción, not the active one', async () => {
    vi.mocked(operarioHasAlmacen).mockResolvedValue(true)
    const sesion = await crearSesion({ almacenId: mad1.id })
    const paquete = await crearPaquete(sesion.id)

    const resultado = await llamar({ sesionId: sesion.id, itemId: paquete.id })

    expect(resultado.ok).toBe(true)
    expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mad1.id)
    expect(funcionDelDominio()).toHaveBeenCalledTimes(1)
  })
})

describe.each(EN_EL_ALMACEN_ACTIVO)('%s: authentication and almacén', (_nombre, llamar) => {
  it('answers with the expired-session message, and does nothing, when there is no session', async () => {
    vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('No session token'))

    expect(await llamar()).toEqual({ ok: false, error: SESION_VENCIDA })

    expect(requireAlmacenActivo).not.toHaveBeenCalled()
    noSeLlamoAlDominio()
  })

  it('tells an operario without almacenes to ask the admin, and does nothing', async () => {
    vi.mocked(requireAlmacenActivo).mockRejectedValue(new ErrorParaOperario(SIN_ALMACENES))

    expect(await llamar()).toEqual({ ok: false, error: SIN_ALMACENES })

    expect(requireAlmacenActivo).toHaveBeenCalledWith(operario.id)
    noSeLlamoAlDominio()
  })
})

describe('abrirRecepcionAction', () => {
  it('opens the recepción in the active almacén', async () => {
    vi.mocked(abrirRecepcion).mockResolvedValue('sesion-1')

    expect(await abrirRecepcionAction(673)).toEqual({ ok: true, valor: { sesionId: 'sesion-1' } })

    expect(requireAlmacenActivo).toHaveBeenCalledWith(operario.id)
    expect(abrirRecepcion).toHaveBeenCalledWith({ almacenId: mb92.id, barcoOdooId: 673, operarioId: operario.id })
  })

  it('does not revalidate: an empty recepción is not in any list', async () => {
    vi.mocked(abrirRecepcion).mockResolvedValue('sesion-1')

    await abrirRecepcionAction(673)

    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('hides a failure of the domain behind the generic message', async () => {
    const consola = silenciarConsoleError()
    vi.mocked(abrirRecepcion).mockRejectedValue(new Error('duplicate key value violates unique constraint'))

    expect(await abrirRecepcionAction(673)).toEqual({ ok: false, error: 'Algo falló. Probá de nuevo.' })
    expect(consola).toHaveBeenCalled()
  })
})

describe('escanearAction', () => {
  const agregado: ResultadoEscaneo = {
    tipo: 'agregado',
    paquete: { id: 'item-1', trackingNumber: 'T1', courierId: 1, courierNombre: 'DHL', estado: 'ok', duplicadoRef: null },
  }

  it('scans into the recepción as the operario of the session, and gives back what the domain answered', async () => {
    const sesion = await crearSesion()
    vi.mocked(escanearPaquete).mockResolvedValue(agregado)

    const resultado = await escanearAction({ sesionId: sesion.id, courierId: dhl.id, trackingNumber: 'T1' })

    expect(resultado).toEqual({ ok: true, valor: agregado })
    expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mb92.id)
    expect(escanearPaquete).toHaveBeenCalledWith({ sesionId: sesion.id, courierId: dhl.id, trackingNumber: 'T1', operarioId: operario.id })
  })

  it('does not revalidate: every scan has to stay light', async () => {
    const sesion = await crearSesion()
    vi.mocked(escanearPaquete).mockResolvedValue(agregado)

    await escanearAction({ sesionId: sesion.id, courierId: dhl.id, trackingNumber: 'T1' })

    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('gives back a repetido as an answer, not as a failure', async () => {
    const sesion = await crearSesion()
    const repetido: ResultadoEscaneo = { tipo: 'repetido', trackingNumber: 'T1', donde: 'la recepción de MAYANQUEENIV' }
    vi.mocked(escanearPaquete).mockResolvedValue(repetido)

    expect(await escanearAction({ sesionId: sesion.id, courierId: dhl.id, trackingNumber: 'T1' }))
      .toEqual({ ok: true, valor: repetido })
  })

  it('takes the operario from the session, never from the input', async () => {
    const sesion = await crearSesion()
    vi.mocked(escanearPaquete).mockResolvedValue(agregado)
    const entrada = { sesionId: sesion.id, courierId: dhl.id, trackingNumber: 'T1', operarioId: 'otro-operario' }

    await escanearAction(entrada)

    expect(escanearPaquete).toHaveBeenCalledWith({ sesionId: sesion.id, courierId: dhl.id, trackingNumber: 'T1', operarioId: operario.id })
  })

  it('shows the message of a domain error that is meant for the operario', async () => {
    const sesion = await crearSesion()
    vi.mocked(escanearPaquete).mockRejectedValue(new RecepcionCerradaError())

    expect(await escanearAction({ sesionId: sesion.id, courierId: dhl.id, trackingNumber: 'T1' }))
      .toEqual({ ok: false, error: 'Esta recepción ya se envió a Odoo.' })
  })

  it('hides a technical failure of the domain behind the generic message', async () => {
    const consola = silenciarConsoleError()
    const sesion = await crearSesion()
    vi.mocked(escanearPaquete).mockRejectedValue(new Error('insert or update on table violates foreign key constraint'))

    expect(await escanearAction({ sesionId: sesion.id, courierId: dhl.id, trackingNumber: 'T1' }))
      .toEqual({ ok: false, error: 'Algo falló. Probá de nuevo.' })
    expect(consola).toHaveBeenCalled()
  })
})

describe('borrarPaqueteAction', () => {
  it('takes the package out through the domain, after finding the recepción it is in', async () => {
    const sesion = await crearSesion()
    const paquete = await crearPaquete(sesion.id)

    expect(await borrarPaqueteAction(paquete.id)).toEqual({ ok: true, valor: undefined })

    expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mb92.id)
    expect(borrarPaquete).toHaveBeenCalledTimes(1)
    expect(borrarPaquete).toHaveBeenCalledWith(paquete.id)
  })

  it('finds the recepción of a package whatever courier it was scanned under', async () => {
    const gls = await seedCourier(db, { nombre: 'GLS', odooProductId: 12 })
    const sesion = await crearSesion({ almacenId: mad1.id })
    await crearPaquete(sesion.id, 'T1', dhl)
    const delOtroCourier = await crearPaquete(sesion.id, 'T2', gls)

    expect(await borrarPaqueteAction(delOtroCourier.id)).toEqual({ ok: false, error: SIN_ACCESO })

    expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mad1.id)
    expect(borrarPaquete).not.toHaveBeenCalled()
  })

  it('does not revalidate', async () => {
    const sesion = await crearSesion()
    const paquete = await crearPaquete(sesion.id)

    await borrarPaqueteAction(paquete.id)

    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('has nothing to do for a package that is already gone: the other tablet took it out first', async () => {
    expect(await borrarPaqueteAction(NO_EXISTE)).toEqual({ ok: true, valor: undefined })

    expect(operarioHasAlmacen).not.toHaveBeenCalled()
    noSeLlamoAlDominio()
  })

  it.each(['s1', '', 'not-a-uuid', undefined, null, 42])(
    'treats %j like a package that is already gone',
    async (itemId) => {
      expect(await borrarPaqueteAction(itemId as never)).toEqual({ ok: true, valor: undefined })

      noSeLlamoAlDominio()
    },
  )

  it('leaves alone a package that is not in a recepción', async () => {
    const entrega = await crearSesion({ tipo: 'entrega', estado: 'confirmada_pendiente_sync' })
    const paquete = await crearPaquete(entrega.id)

    expect(await borrarPaqueteAction(paquete.id)).toEqual({ ok: true, valor: undefined })

    noSeLlamoAlDominio()
  })

  it('shows the message of a recepción that was already sent', async () => {
    const sesion = await crearSesion()
    const paquete = await crearPaquete(sesion.id)
    vi.mocked(borrarPaquete).mockRejectedValue(new RecepcionCerradaError())

    expect(await borrarPaqueteAction(paquete.id)).toEqual({ ok: false, error: 'Esta recepción ya se envió a Odoo.' })
  })
})

describe('enviarRecepcionAction', () => {
  it.each(['enviada', 'sin_paquetes_validos', 'vacia_descartada'] as const)(
    'sends the recepción for the operario and says how it went (%s)',
    async (resultado) => {
      const sesion = await crearSesion()
      vi.mocked(enviarRecepcion).mockResolvedValue(resultado)

      expect(await enviarRecepcionAction(sesion.id)).toEqual({ ok: true, valor: resultado })

      expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mb92.id)
      expect(enviarRecepcion).toHaveBeenCalledWith({ sesionId: sesion.id, operarioId: operario.id })
    },
  )

  it('revalidates the reception lists', async () => {
    const sesion = await crearSesion()
    vi.mocked(enviarRecepcion).mockResolvedValue('enviada')

    await enviarRecepcionAction(sesion.id)

    expect(revalidatePath).toHaveBeenCalledWith('/recepcion')
  })

  it('does not revalidate when nothing was sent because the domain refused', async () => {
    const sesion = await crearSesion()
    vi.mocked(enviarRecepcion).mockRejectedValue(new RecepcionCerradaError())

    expect(await enviarRecepcionAction(sesion.id)).toEqual({ ok: false, error: 'Esta recepción ya se envió a Odoo.' })

    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('enviarTodasAction', () => {
  it('sends the open recepciones of the active almacén', async () => {
    vi.mocked(enviarRecepcionesAbiertas).mockResolvedValue(3)

    expect(await enviarTodasAction()).toEqual({ ok: true, valor: { enviadas: 3 } })

    expect(requireAlmacenActivo).toHaveBeenCalledWith(operario.id)
    expect(enviarRecepcionesAbiertas).toHaveBeenCalledTimes(1)
    expect(enviarRecepcionesAbiertas).toHaveBeenCalledWith({ almacenId: mb92.id, operarioId: operario.id })
    expect(vi.mocked(enviarRecepcionesAbiertas).mock.calls[0][0]).not.toHaveProperty('barcoOdooId')
  })

  it('revalidates the reception lists', async () => {
    vi.mocked(enviarRecepcionesAbiertas).mockResolvedValue(0)

    await enviarTodasAction()

    expect(revalidatePath).toHaveBeenCalledWith('/recepcion')
  })

  it('revalidates the lists even when the sending stops halfway, since the first ones were sent', async () => {
    const consola = silenciarConsoleError()
    vi.mocked(enviarRecepcionesAbiertas).mockRejectedValue(new Error('QStash unreachable'))

    expect(await enviarTodasAction()).toEqual({ ok: false, error: 'Algo falló. Probá de nuevo.' })

    expect(revalidatePath).toHaveBeenCalledWith('/recepcion')
    expect(consola).toHaveBeenCalled()
  })
})

describe('descartarRecepcionAction', () => {
  it('discards the recepción for the operario and revalidates the lists', async () => {
    const sesion = await crearSesion()

    expect(await descartarRecepcionAction(sesion.id)).toEqual({ ok: true, valor: undefined })

    expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mb92.id)
    expect(descartarRecepcion).toHaveBeenCalledWith({ sesionId: sesion.id, operarioId: operario.id })
    expect(revalidatePath).toHaveBeenCalledWith('/recepcion')
  })

  it('is the explicit discard: it never goes through the guarded one', async () => {
    const sesion = await crearSesion()

    await descartarRecepcionAction(sesion.id)

    expect(descartarSiVacia).not.toHaveBeenCalled()
  })

  it('shows the message of a recepción that was already sent, and does not revalidate', async () => {
    const sesion = await crearSesion()
    vi.mocked(descartarRecepcion).mockRejectedValue(new RecepcionCerradaError())

    expect(await descartarRecepcionAction(sesion.id)).toEqual({ ok: false, error: 'Esta recepción ya se envió a Odoo.' })

    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('descartarSiVaciaAction', () => {
  it('discards an empty recepción and revalidates the lists', async () => {
    const sesion = await crearSesion()
    vi.mocked(descartarSiVacia).mockResolvedValue(true)

    expect(await descartarSiVaciaAction(sesion.id)).toEqual({ ok: true, valor: { descartada: true } })

    expect(operarioHasAlmacen).toHaveBeenCalledWith(operario.id, mb92.id)
    expect(descartarSiVacia).toHaveBeenCalledWith({ sesionId: sesion.id, operarioId: operario.id })
    expect(revalidatePath).toHaveBeenCalledWith('/recepcion')
  })

  it('leaves a recepción that has a package, and has nothing to revalidate', async () => {
    const sesion = await crearSesion()
    await crearPaquete(sesion.id)
    vi.mocked(descartarSiVacia).mockResolvedValue(false)

    expect(await descartarSiVaciaAction(sesion.id)).toEqual({ ok: true, valor: { descartada: false } })

    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('is the guarded discard: it never goes through the one that deletes what is inside', async () => {
    const sesion = await crearSesion()
    vi.mocked(descartarSiVacia).mockResolvedValue(true)

    await descartarSiVaciaAction(sesion.id)

    expect(descartarRecepcion).not.toHaveBeenCalled()
  })
})

describe('asignarYEscanearAction', () => {
  const agregado: ResultadoEscaneo = {
    tipo: 'agregado',
    paquete: { id: 'item-1', trackingNumber: 'JJD1', courierId: 1, courierNombre: 'DHL', estado: 'ok', duplicadoRef: null },
  }

  it('opens the recepción of the barco in the active almacén and scans the package into it', async () => {
    vi.mocked(abrirRecepcion).mockResolvedValue('sesion-1')
    vi.mocked(escanearPaquete).mockResolvedValue(agregado)

    const resultado = await asignarYEscanearAction({ barcoOdooId: 673, courierId: dhl.id, trackingNumber: 'JJD1' })

    expect(resultado).toEqual({ ok: true, valor: { sesionId: 'sesion-1', resultado: agregado } })
    expect(requireAlmacenActivo).toHaveBeenCalledWith(operario.id)
    expect(abrirRecepcion).toHaveBeenCalledWith({ almacenId: mb92.id, barcoOdooId: 673, operarioId: operario.id })
    expect(escanearPaquete).toHaveBeenCalledWith({ sesionId: 'sesion-1', courierId: dhl.id, trackingNumber: 'JJD1', operarioId: operario.id })
  })

  it('gives back a repetido together with the recepción it was opened in', async () => {
    const repetido: ResultadoEscaneo = { tipo: 'repetido', trackingNumber: 'JJD1', donde: 'la recepción de MAYANQUEENIV' }
    vi.mocked(abrirRecepcion).mockResolvedValue('sesion-1')
    vi.mocked(escanearPaquete).mockResolvedValue(repetido)

    expect(await asignarYEscanearAction({ barcoOdooId: 673, courierId: dhl.id, trackingNumber: 'JJD1' }))
      .toEqual({ ok: true, valor: { sesionId: 'sesion-1', resultado: repetido } })
  })

  it('tells the operario why the scan was refused', async () => {
    vi.mocked(abrirRecepcion).mockResolvedValue('sesion-1')
    vi.mocked(escanearPaquete).mockRejectedValue(new EscaneoInvalidoError('El código está vacío.'))

    expect(await asignarYEscanearAction({ barcoOdooId: 673, courierId: dhl.id, trackingNumber: '  ' }))
      .toEqual({ ok: false, error: 'El código está vacío.' })
  })

  it('does not revalidate', async () => {
    vi.mocked(abrirRecepcion).mockResolvedValue('sesion-1')
    vi.mocked(escanearPaquete).mockResolvedValue(agregado)

    await asignarYEscanearAction({ barcoOdooId: 673, courierId: dhl.id, trackingNumber: 'JJD1' })

    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('an id that does not name a recepción', () => {
  /** What the client could send in place of the id of a recepción. */
  const IDS: Array<[descripcion: string, darId: () => Promise<string>]> = [
    ['an id that does not exist', async () => NO_EXISTE],
    ['text that is not an id', async () => 's1'],
    ['an empty id', async () => ''],
    ['no id at all', async () => undefined as never],
    ['the id of an entrega', async () => (await crearSesion({ tipo: 'entrega', estado: 'confirmada_pendiente_sync' })).id],
  ]

  describe.each(IDS)('%s', (_descripcion, darId) => {
    it('escanearAction says the recepción does not exist', async () => {
      const sesionId = await darId()

      expect(await escanearAction({ sesionId, courierId: dhl.id, trackingNumber: 'T1' }))
        .toEqual({ ok: false, error: SIN_RECEPCION })

      noSeLlamoAlDominio()
      expect(operarioHasAlmacen).not.toHaveBeenCalled()
    })

    it('enviarRecepcionAction says the recepción does not exist', async () => {
      expect(await enviarRecepcionAction(await darId())).toEqual({ ok: false, error: SIN_RECEPCION })

      noSeLlamoAlDominio()
      expect(revalidatePath).not.toHaveBeenCalled()
    })

    it('descartarRecepcionAction has nothing to discard: the recepción is gone either way', async () => {
      expect(await descartarRecepcionAction(await darId())).toEqual({ ok: true, valor: undefined })

      noSeLlamoAlDominio()
      expect(revalidatePath).toHaveBeenCalledWith('/recepcion')
    })

    it('descartarSiVaciaAction does not discard anything', async () => {
      expect(await descartarSiVaciaAction(await darId())).toEqual({ ok: true, valor: { descartada: false } })

      noSeLlamoAlDominio()
      expect(revalidatePath).not.toHaveBeenCalled()
    })
  })

  // Postgres would refuse these as ids (a failure that is logged and read as "Algo falló"), and the array is
  // the sly one: a regular expression reads [id] as that id, so only a check of the type keeps it from the query.
  it.each(['s1', '', 'not-a-uuid', undefined, null, 42, [NO_EXISTE]])(
    'does not even query the database with %j as an id',
    async (id) => {
      const consultaDeRecepcion = vi.spyOn(db.query.sesionesEscaneo, 'findFirst')
      const consultaDePaquete = vi.spyOn(db, 'select')

      await escanearAction({ sesionId: id as never, courierId: dhl.id, trackingNumber: 'T1' })
      await descartarSiVaciaAction(id as never)
      await borrarPaqueteAction(id as never)

      expect(consultaDeRecepcion).not.toHaveBeenCalled()
      expect(consultaDePaquete).not.toHaveBeenCalled()
    },
  )
})
