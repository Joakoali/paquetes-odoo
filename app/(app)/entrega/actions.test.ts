import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The actions only authenticate, check the almacén and translate errors: what they call is replaced, and the database
// is something no test here may touch (vitest.setup.ts loads the real .env when there is one).
vi.mock('@/db/client', () => ({
  db: new Proxy({}, { get: () => { throw new Error('This test must not touch the database') } }),
}))
vi.mock('next/cache', () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/almacen-activo', () => ({ requireAlmacenActivo: vi.fn() }))
vi.mock('@/lib/entrega/entregas', () => ({ registrarEntrega: vi.fn(), entregaGuardada: vi.fn(), moveLineIdsRetenidas: vi.fn() }))
// The action re-reads what Odoo has waiting for the barco: the one read it makes outside the queue.
vi.mock('@/lib/odoo/pickings', () => ({ getLineasEntregaPendiente: vi.fn() }))
vi.mock('@/lib/recepcion/recepciones', () => ({ enviarRecepcionesAbiertas: vi.fn() }))

import { refresh, revalidatePath } from 'next/cache'
import type { Almacen, Operario } from '@/db/schema'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { entregaGuardada, moveLineIdsRetenidas, registrarEntrega } from '@/lib/entrega/entregas'
import { ErrorParaOperario, OdooError } from '@/lib/errores'
import { getLineasEntregaPendiente, type LineaEntrega } from '@/lib/odoo/pickings'
import { enviarRecepcionesAbiertas } from '@/lib/recepcion/recepciones'
import { LECTURA_DE_ODOO_FALLIDA } from '@/lib/ui/lectura-fallida'
import { confirmarEntregaAction, enviarRecepcionesDelBarcoAction } from './actions'

const SESION_VENCIDA = 'Tu sesión venció. Volvé a entrar.'
const SIN_ALMACENES = 'No tenés almacenes asignados. Avisá al admin.'
const GENERICO = 'Algo falló. Probá de nuevo.'
const SIN_NOMBRE = 'Falta el nombre de quien recibe.'
const NOMBRE_LARGO = 'El nombre de quien recibe es demasiado largo.'
const SIN_PAQUETES = 'Elegí al menos un paquete.'
const SIN_FIRMA = 'Falta la firma.'
const ENTREGA_INVALIDA = 'Esa entrega no es válida. Volvé a abrir el barco.'
const YA_NO_PENDIENTES = 'Algunos paquetes ya no están pendientes de entrega. Volvé a abrir el barco.'
const EN_ENVIO = 'Algunos paquetes ya están en una entrega que se está enviando a Odoo. Volvé a abrir el barco.'

const ID = '5f0c7a9e-3b1d-4c55-9a52-0d9a3c1e7b10'
const FIRMA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario
/** The active almacén. */
const mb92 = { id: 4, prefijo: 'MB92', odooOutTypeId: 2 } as Almacen

/** A package waiting for delivery, as Odoo has it. */
const linea = (moveLineId: number, pickingId = 700): LineaEntrega => ({
  moveLineId, pickingId, pickingRef: `MB92/OUT/00${pickingId}`, trackingNumber: `T${moveLineId}`, courierNombre: 'DHL',
})
/** What Odoo has waiting for the barco: two lines of one delivery, and one of another. */
const lineasEnOdoo = [linea(11), linea(12), linea(21, 701)]

/** What the phone sends when the crew confirms: two lines of one delivery. */
const entrada = (datos: Partial<Parameters<typeof confirmarEntregaAction>[0]> = {}) => ({
  id: ID,
  barcoOdooId: 673,
  moveLineIds: [11, 12],
  receptorNombre: 'Tom Baker',
  firmaDataUrl: FIRMA,
  ...datos,
})

const silenciarConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => {})

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(operario)
  vi.mocked(requireAlmacenActivo).mockResolvedValue(mb92)
  vi.mocked(getLineasEntregaPendiente).mockResolvedValue(lineasEnOdoo)
  vi.mocked(moveLineIdsRetenidas).mockResolvedValue(new Set())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('confirmarEntregaAction', () => {
  it('passes the request to registrarEntrega with the active almacén and the operario of the session', async () => {
    expect(await confirmarEntregaAction(entrada())).toEqual({ ok: true, valor: undefined })

    expect(requireAlmacenActivo).toHaveBeenCalledWith(operario.id)
    expect(registrarEntrega).toHaveBeenCalledTimes(1)
    expect(registrarEntrega).toHaveBeenCalledWith({
      id: ID,
      operarioId: operario.id,
      almacenId: mb92.id,
      barcoOdooId: 673,
      pickingIds: [700],
      moveLineIds: [11, 12],
      // What those lines are, as Odoo lists them: the entrega keeps it.
      paquetes: [
        { trackingNumber: 'T11', courierNombre: 'DHL', pickingRef: 'MB92/OUT/00700' },
        { trackingNumber: 'T12', courierNombre: 'DHL', pickingRef: 'MB92/OUT/00700' },
      ],
      receptorNombre: 'Tom Baker',
      // As the canvas made it: the domain strips the `data:image/png;base64,`.
      firmaBase64: FIRMA,
    })
  })

  it('revalidates nothing: that would re-render the barco page the phone is on, in the same response', async () => {
    // Next re-renders the CURRENT route whatever path is revalidated. The re-render reads Odoo again (twice, on an instance
    // that admits one request a second), and its lines have changed: the flow would remount before it could say "Entrega
    // registrada", back at the packages with all of them chosen and a fresh id, or the page could even come back as a
    // failed reading. The list of Entrega is not cached on the client (a dynamic page), so going there reads it afresh.
    expect(await confirmarEntregaAction(entrada())).toEqual({ ok: true, valor: undefined })

    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('takes the operario and the almacén from the session, never from the input', async () => {
    const conDatosAjenos = { ...entrada(), operarioId: 'otro-operario', almacenId: 99 }

    await confirmarEntregaAction(conDatosAjenos)

    expect(registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ operarioId: operario.id, almacenId: mb92.id }))
  })

  it('trims the name before it goes in', async () => {
    await confirmarEntregaAction(entrada({ receptorNombre: '  Tom Baker \n' }))

    expect(registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ receptorNombre: 'Tom Baker' }))
  })

  it('sends the same id again on a retry, so that the domain can tell it is the same entrega', async () => {
    await confirmarEntregaAction(entrada())
    await confirmarEntregaAction(entrada())

    expect(vi.mocked(registrarEntrega).mock.calls.map(([datos]) => datos.id)).toEqual([ID, ID])
  })

  describe('what the phone sends is checked against what Odoo has waiting for the barco in the almacén', () => {
    it('reads the lines of that barco in the delivery type of the active almacén, once', async () => {
      await confirmarEntregaAction(entrada())

      expect(getLineasEntregaPendiente).toHaveBeenCalledTimes(1)
      expect(getLineasEntregaPendiente).toHaveBeenCalledWith({ outTypeId: mb92.odooOutTypeId, barcoOdooId: 673 })
    })

    it('derives the deliveries from the lines accepted, not from what the phone says', async () => {
      // The client's `pickingIds` (one of another almacén, say) is not a thing the action looks at.
      const conPickingAjeno = { ...entrada({ moveLineIds: [12, 21] }), pickingIds: [999] }

      expect(await confirmarEntregaAction(conPickingAjeno)).toEqual({ ok: true, valor: undefined })

      expect(registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ moveLineIds: [12, 21], pickingIds: [700, 701] }))
    })

    it('touches only the deliveries of the lines that were chosen', async () => {
      await confirmarEntregaAction(entrada({ moveLineIds: [21] }))

      expect(registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ moveLineIds: [21], pickingIds: [701] }))
    })

    it('registers a line once even if the phone lists it twice', async () => {
      await confirmarEntregaAction(entrada({ moveLineIds: [11, 11, 12] }))

      expect(registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ moveLineIds: [11, 12], pickingIds: [700] }))
    })

    it('rejects a line that is not among what Odoo has waiting for the barco in this almacén: nothing is registered', async () => {
      // 555 is a package of another almacén's delivery, or of another barco: Odoo does not list it here.
      expect(await confirmarEntregaAction(entrada({ moveLineIds: [11, 555] }))).toEqual({ ok: false, error: YA_NO_PENDIENTES })

      expect(registrarEntrega).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    })

    it('rejects when none of the lines is among them', async () => {
      expect(await confirmarEntregaAction(entrada({ moveLineIds: [555] }))).toEqual({ ok: false, error: YA_NO_PENDIENTES })

      expect(registrarEntrega).not.toHaveBeenCalled()
    })

    it('rejects lines that are not whole numbers of Odoo ids', async () => {
      for (const ids of [['11'], [11.5], [null], [{}], [-11]]) {
        expect(await confirmarEntregaAction(entrada({ moveLineIds: ids as unknown as number[] }))).toEqual({ ok: false, error: YA_NO_PENDIENTES })
      }

      expect(registrarEntrega).not.toHaveBeenCalled()
    })

    it('rejects everything when Odoo has nothing waiting for the barco any more', async () => {
      vi.mocked(getLineasEntregaPendiente).mockResolvedValue([])

      expect(await confirmarEntregaAction(entrada())).toEqual({ ok: false, error: YA_NO_PENDIENTES })

      expect(registrarEntrega).not.toHaveBeenCalled()
    })

    it('says Odoo could not be read, and registers nothing, when the read fails, so that the phone can retry as it was', async () => {
      vi.mocked(getLineasEntregaPendiente).mockRejectedValue(new OdooError({ status: 502, data: '<html>Bad gateway</html>' }))

      expect(await confirmarEntregaAction(entrada())).toEqual({ ok: false, error: LECTURA_DE_ODOO_FALLIDA })

      expect(registrarEntrega).not.toHaveBeenCalled()
    })

    it('lets a bug in the read through as an unexpected failure, not as something to tell the operario', async () => {
      const consola = silenciarConsoleError()
      vi.mocked(getLineasEntregaPendiente).mockRejectedValue(new Error('Cannot read properties of undefined'))

      expect(await confirmarEntregaAction(entrada())).toEqual({ ok: false, error: GENERICO })

      expect(consola).toHaveBeenCalled()
      expect(registrarEntrega).not.toHaveBeenCalled()
    })

    it('does not read Odoo, and says what to do, when the almacén has no delivery type', async () => {
      vi.mocked(requireAlmacenActivo).mockResolvedValue({ ...mb92, odooOutTypeId: null })

      expect(await confirmarEntregaAction(entrada())).toEqual({
        ok: false, error: 'El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.',
      })

      expect(getLineasEntregaPendiente).not.toHaveBeenCalled()
      expect(registrarEntrega).not.toHaveBeenCalled()
    })

    it('lets a retry of an entrega that was already saved through without asking Odoo: what it holds is no longer waiting once it synced', async () => {
      vi.mocked(entregaGuardada).mockResolvedValue(true)
      vi.mocked(getLineasEntregaPendiente).mockResolvedValue([]) // the worker already delivered them

      expect(await confirmarEntregaAction(entrada())).toEqual({ ok: true, valor: undefined })

      expect(entregaGuardada).toHaveBeenCalledWith(ID, mb92.id)
      expect(getLineasEntregaPendiente).not.toHaveBeenCalled()
      expect(moveLineIdsRetenidas).not.toHaveBeenCalled()
      expect(registrarEntrega).toHaveBeenCalledTimes(1)
      expect(registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ id: ID, almacenId: mb92.id, operarioId: operario.id }))
      // Nothing of what the retry sends is used: the packages the first try saved stay as they are.
      expect(registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ moveLineIds: [], pickingIds: [], paquetes: [] }))
    })
  })

  describe('lines that an entrega of this almacén and barco on its way to Odoo already holds', () => {
    it('asks which lines are held for this almacén and barco, leaving out the entrega that is being confirmed', async () => {
      await confirmarEntregaAction(entrada())

      // Leaving out its own id is what lets a retry of the same entrega through while its own lines are held.
      expect(moveLineIdsRetenidas).toHaveBeenCalledTimes(1)
      expect(moveLineIdsRetenidas).toHaveBeenCalledWith({ almacenId: mb92.id, barcoOdooId: 673, exceptoId: ID })
    })

    it('rejects a held line with a plain message of its own, and registers nothing: it would be delivered twice', async () => {
      vi.mocked(moveLineIdsRetenidas).mockResolvedValue(new Set([12]))

      expect(await confirmarEntregaAction(entrada({ moveLineIds: [11, 12] }))).toEqual({ ok: false, error: EN_ENVIO })

      expect(registrarEntrega).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    })

    it('accepts the lines that are not held, whatever others are', async () => {
      vi.mocked(moveLineIdsRetenidas).mockResolvedValue(new Set([12, 21]))

      expect(await confirmarEntregaAction(entrada({ moveLineIds: [11] }))).toEqual({ ok: true, valor: undefined })

      expect(registrarEntrega).toHaveBeenCalledWith(expect.objectContaining({ moveLineIds: [11], pickingIds: [700] }))
    })

    it('does not hide a failure to read what is held: nothing is registered', async () => {
      const consola = silenciarConsoleError()
      vi.mocked(moveLineIdsRetenidas).mockRejectedValue(new Error('connection refused'))

      expect(await confirmarEntregaAction(entrada())).toEqual({ ok: false, error: GENERICO })

      expect(consola).toHaveBeenCalled()
      expect(registrarEntrega).not.toHaveBeenCalled()
    })
  })

  describe('the ids that identify the entrega and the barco are checked first of all', () => {
    const ID_INVALIDOS = ['', 'abc', '5f0c7a9e-3b1d-4c55-9a52-0d9a3c1e7b1', '5f0c7a9e3b1d4c559a520d9a3c1e7b10', `${ID} `, 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']

    it.each(ID_INVALIDOS)('rejects the entrega id "%s" before the session, the almacén or Odoo are touched', async (id) => {
      expect(await confirmarEntregaAction(entrada({ id }))).toEqual({ ok: false, error: ENTREGA_INVALIDA })

      expect(requireOperarioFromCookies).not.toHaveBeenCalled()
      expect(requireAlmacenActivo).not.toHaveBeenCalled()
      expect(getLineasEntregaPendiente).not.toHaveBeenCalled()
      expect(registrarEntrega).not.toHaveBeenCalled()
    })

    it('rejects an entrega id that is not a string', async () => {
      expect(await confirmarEntregaAction(entrada({ id: 42 as unknown as string }))).toEqual({ ok: false, error: ENTREGA_INVALIDA })
      expect(await confirmarEntregaAction(entrada({ id: undefined as unknown as string }))).toEqual({ ok: false, error: ENTREGA_INVALIDA })
    })

    it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648, '673', null, undefined])('rejects the barco id %s', async (barcoOdooId) => {
      expect(await confirmarEntregaAction(entrada({ barcoOdooId: barcoOdooId as unknown as number }))).toEqual({ ok: false, error: ENTREGA_INVALIDA })

      expect(requireOperarioFromCookies).not.toHaveBeenCalled()
      expect(getLineasEntregaPendiente).not.toHaveBeenCalled()
      expect(registrarEntrega).not.toHaveBeenCalled()
    })

    it('accepts an id in capitals, as some devices write it', async () => {
      expect((await confirmarEntregaAction(entrada({ id: ID.toUpperCase() }))).ok).toBe(true)
    })
  })

  describe('validation: nothing is registered nor revalidated', () => {
    const noSeRegistro = () => {
      expect(registrarEntrega).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
      // What the screen already makes sure of is not worth a read of Odoo.
      expect(getLineasEntregaPendiente).not.toHaveBeenCalled()
    }

    it('rejects an empty crew name', async () => {
      expect(await confirmarEntregaAction(entrada({ receptorNombre: '' }))).toEqual({ ok: false, error: SIN_NOMBRE })
      noSeRegistro()
    })

    it('rejects a name of only blanks: it is trimmed first', async () => {
      expect(await confirmarEntregaAction(entrada({ receptorNombre: ' \t  ' }))).toEqual({ ok: false, error: SIN_NOMBRE })
      noSeRegistro()
    })

    it('rejects a name longer than 80 characters', async () => {
      expect(await confirmarEntregaAction(entrada({ receptorNombre: 'a'.repeat(81) }))).toEqual({ ok: false, error: NOMBRE_LARGO })
      noSeRegistro()
    })

    it('accepts a name of exactly 80 characters, and counts it once trimmed', async () => {
      const ochenta = 'a'.repeat(80)

      expect((await confirmarEntregaAction(entrada({ receptorNombre: ochenta }))).ok).toBe(true)
      expect((await confirmarEntregaAction(entrada({ receptorNombre: `  ${ochenta}  ` }))).ok).toBe(true)
      expect(registrarEntrega).toHaveBeenCalledTimes(2)
    })

    it('rejects a confirmation without packages: it would be registered and do nothing in Odoo', async () => {
      expect(await confirmarEntregaAction(entrada({ moveLineIds: [] }))).toEqual({ ok: false, error: SIN_PAQUETES })
      noSeRegistro()
    })

    it('rejects a confirmation without signature', async () => {
      expect(await confirmarEntregaAction(entrada({ firmaDataUrl: '' }))).toEqual({ ok: false, error: SIN_FIRMA })
      noSeRegistro()
    })

    it('rejects a signature that is not a PNG as the canvas gives it: it would be written to Odoo as it comes', async () => {
      expect(await confirmarEntregaAction(entrada({ firmaDataUrl: 'data:image/png;base64,' }))).toEqual({ ok: false, error: SIN_FIRMA })
      expect(await confirmarEntregaAction(entrada({ firmaDataUrl: 'iVBORw0KGgo=' }))).toEqual({ ok: false, error: SIN_FIRMA })
      expect(await confirmarEntregaAction(entrada({ firmaDataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }))).toEqual({ ok: false, error: SIN_FIRMA })
      noSeRegistro()
    })

    it('says the name is missing first when more than one thing is', async () => {
      expect(await confirmarEntregaAction(entrada({ receptorNombre: '', moveLineIds: [], firmaDataUrl: '' })))
        .toEqual({ ok: false, error: SIN_NOMBRE })
    })
  })

  describe('authentication and almacén', () => {
    it('answers with the expired-session message, and does nothing, when there is no session', async () => {
      vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

      expect(await confirmarEntregaAction(entrada())).toEqual({ ok: false, error: SESION_VENCIDA })

      expect(requireAlmacenActivo).not.toHaveBeenCalled()
      expect(registrarEntrega).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    })

    it('tells an operario without almacenes to ask the admin, and does nothing', async () => {
      vi.mocked(requireAlmacenActivo).mockRejectedValue(new ErrorParaOperario(SIN_ALMACENES))

      expect(await confirmarEntregaAction(entrada())).toEqual({ ok: false, error: SIN_ALMACENES })

      expect(registrarEntrega).not.toHaveBeenCalled()
    })
  })

  describe('when the domain fails', () => {
    it('answers with the failure, so the phone keeps everything and can retry, and does not revalidate', async () => {
      const consola = silenciarConsoleError()
      vi.mocked(registrarEntrega).mockRejectedValue(new Error('QStash is disabled'))

      expect(await confirmarEntregaAction(entrada())).toEqual({ ok: false, error: GENERICO })

      expect(consola).toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    })

    it('shows the message of an error that is written for the operario', async () => {
      vi.mocked(registrarEntrega).mockRejectedValue(new ErrorParaOperario('Algo que el operario puede leer.'))

      expect(await confirmarEntregaAction(entrada())).toEqual({ ok: false, error: 'Algo que el operario puede leer.' })
    })
  })
})

describe('enviarRecepcionesDelBarcoAction', () => {
  it('sends the open recepciones of that barco in the active almacén, and says how many it sent', async () => {
    vi.mocked(enviarRecepcionesAbiertas).mockResolvedValue(2)

    expect(await enviarRecepcionesDelBarcoAction(673)).toEqual({ ok: true, valor: { enviadas: 2 } })

    expect(requireAlmacenActivo).toHaveBeenCalledWith(operario.id)
    expect(enviarRecepcionesAbiertas).toHaveBeenCalledWith({ almacenId: mb92.id, operarioId: operario.id, barcoOdooId: 673 })
  })

  it('says 0 when there was nothing to send', async () => {
    vi.mocked(enviarRecepcionesAbiertas).mockResolvedValue(0)

    expect(await enviarRecepcionesDelBarcoAction(673)).toEqual({ ok: true, valor: { enviadas: 0 } })
  })

  it('revalidates the lists of Entrega and Recepción: what was sent is not unsent, nor open, any more', async () => {
    vi.mocked(enviarRecepcionesAbiertas).mockResolvedValue(1)

    await enviarRecepcionesDelBarcoAction(673)

    expect(revalidatePath).toHaveBeenCalledWith('/entrega')
    expect(revalidatePath).toHaveBeenCalledWith('/recepcion')
  })

  it('draws the barco it is called from again in its answer, since the screen does not ask for it again', async () => {
    vi.mocked(enviarRecepcionesAbiertas).mockResolvedValue(1)

    await enviarRecepcionesDelBarcoAction(673)

    expect(refresh).toHaveBeenCalledOnce()
  })

  it('revalidates also when it stops halfway: the recepciones sent before the failure are not open any more', async () => {
    const consola = silenciarConsoleError()
    vi.mocked(enviarRecepcionesAbiertas).mockRejectedValue(new Error('QStash is disabled'))

    expect(await enviarRecepcionesDelBarcoAction(673)).toEqual({ ok: false, error: GENERICO })

    expect(consola).toHaveBeenCalled()
    expect(revalidatePath).toHaveBeenCalledWith('/entrega')
    expect(revalidatePath).toHaveBeenCalledWith('/recepcion')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('answers with the expired-session message, and sends nothing, when there is no session', async () => {
    vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('No session token'))

    expect(await enviarRecepcionesDelBarcoAction(673)).toEqual({ ok: false, error: SESION_VENCIDA })

    expect(requireAlmacenActivo).not.toHaveBeenCalled()
    expect(enviarRecepcionesAbiertas).not.toHaveBeenCalled()
  })

  it('tells an operario without almacenes to ask the admin, and sends nothing', async () => {
    vi.mocked(requireAlmacenActivo).mockRejectedValue(new ErrorParaOperario(SIN_ALMACENES))

    expect(await enviarRecepcionesDelBarcoAction(673)).toEqual({ ok: false, error: SIN_ALMACENES })

    expect(enviarRecepcionesAbiertas).not.toHaveBeenCalled()
  })
})
