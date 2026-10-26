import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The actions only authenticate, check the almacén and translate errors: what they call is replaced, and the database
// is something no test here may touch (vitest.setup.ts loads the real .env when there is one).
vi.mock('@/db/client', () => ({
  db: new Proxy({}, { get: () => { throw new Error('This test must not touch the database') } }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('@/lib/almacen-activo', () => ({ requireAlmacenActivo: vi.fn() }))
vi.mock('@/lib/entrega/entregas', () => ({ registrarEntrega: vi.fn() }))
vi.mock('@/lib/recepcion/recepciones', () => ({ enviarRecepcionesAbiertas: vi.fn() }))

import { revalidatePath } from 'next/cache'
import type { Almacen, Operario } from '@/db/schema'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { registrarEntrega } from '@/lib/entrega/entregas'
import { ErrorParaOperario } from '@/lib/errores'
import { enviarRecepcionesAbiertas } from '@/lib/recepcion/recepciones'
import { confirmarEntregaAction, enviarRecepcionesDelBarcoAction } from './actions'

const SESION_VENCIDA = 'Tu sesión venció. Volvé a entrar.'
const SIN_ALMACENES = 'No tenés almacenes asignados. Avisá al admin.'
const GENERICO = 'Algo falló. Probá de nuevo.'
const SIN_NOMBRE = 'Falta el nombre de quien recibe.'
const NOMBRE_LARGO = 'El nombre de quien recibe es demasiado largo.'
const SIN_PAQUETES = 'Elegí al menos un paquete.'
const SIN_FIRMA = 'Falta la firma.'

const ID = '5f0c7a9e-3b1d-4c55-9a52-0d9a3c1e7b10'
const FIRMA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario
/** The active almacén. */
const mb92 = { id: 4, prefijo: 'MB92', odooOutTypeId: 2 } as Almacen

/** What the phone sends when the crew confirms: two lines of one delivery. */
const entrada = (datos: Partial<Parameters<typeof confirmarEntregaAction>[0]> = {}) => ({
  id: ID,
  barcoOdooId: 673,
  pickingIds: [700],
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
      receptorNombre: 'Tom Baker',
      // As the canvas made it: the domain strips the `data:image/png;base64,`.
      firmaBase64: FIRMA,
    })
  })

  it('revalidates the list of Entrega, where the entrega shows up under "Entregadas hoy"', async () => {
    await confirmarEntregaAction(entrada())

    expect(revalidatePath).toHaveBeenCalledWith('/entrega')
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

  describe('validation: nothing is registered nor revalidated', () => {
    const noSeRegistro = () => {
      expect(registrarEntrega).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
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

    it('rejects a confirmation without packages', async () => {
      expect(await confirmarEntregaAction(entrada({ moveLineIds: [], pickingIds: [] }))).toEqual({ ok: false, error: SIN_PAQUETES })
      noSeRegistro()
    })

    it('rejects lines that are on no delivery, or a delivery with no lines: it would be registered and do nothing in Odoo', async () => {
      expect(await confirmarEntregaAction(entrada({ pickingIds: [] }))).toEqual({ ok: false, error: SIN_PAQUETES })
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

  it('revalidates also when it stops halfway: the recepciones sent before the failure are not open any more', async () => {
    const consola = silenciarConsoleError()
    vi.mocked(enviarRecepcionesAbiertas).mockRejectedValue(new Error('QStash is disabled'))

    expect(await enviarRecepcionesDelBarcoAction(673)).toEqual({ ok: false, error: GENERICO })

    expect(consola).toHaveBeenCalled()
    expect(revalidatePath).toHaveBeenCalledWith('/entrega')
    expect(revalidatePath).toHaveBeenCalledWith('/recepcion')
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
