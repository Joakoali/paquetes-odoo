'use server'

import { refresh, revalidatePath } from 'next/cache'
import type { Almacen, PaqueteDeOdoo } from '@/db/schema'
import { ejecutarAccion, type ResultadoAccion } from '@/lib/acciones'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { barcoActivo } from '@/lib/cache/barcos'
import { lineasRetenidas, registrarEntrega, sesionGuardada } from '@/lib/entrega/entregas'
import { resolverElegidas } from '@/lib/entrega/lineas'
import { registrarReasignacion } from '@/lib/entrega/reasignaciones'
import { ConfiguracionError, ErrorParaOperario } from '@/lib/errores'
import { getLineasEntregaPendiente, type LineaEntrega } from '@/lib/odoo/pickings'
import { enviarRecepcionesAbiertas } from '@/lib/recepcion/recepciones'
import { mensajeDeLecturaFallida } from '@/lib/ui/lectura-fallida'
import { BARCO_DESTINO_DESCONOCIDO, MISMO_BARCO } from '@/lib/ui/mover-paquetes'
import { MAX_NOMBRE_RECEPTOR } from '@/lib/ui/seleccion-entrega'

/**
 * These actions authenticate, check the almacén and translate errors; the work is in the domain, which trusts its
 * parameters. An entrega, or a reasignación of packages to another barco, is made in the almacén the operario is working
 * in: it is the active one, as for every action on the delivery screens.
 *
 * What a phone sends is not trusted, and both are written to production Odoo: the ids they name are checked against what
 * Odoo itself has waiting for the barco in the almacén before anything is saved.
 */

/** What the phone makes up before its first try. Postgres would fail on anything else, with a message that is not for the operario. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The biggest id the `integer` column of the entregas holds: a barco with a bigger one cannot exist. */
const ID_MAXIMO = 2_147_483_647

/** What a canvas gives for a signature: `data:image/png;base64,` and then the image. Odoo is given what comes after it. */
const FIRMA_PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/

/** The id of a barco that can exist: a positive whole number that fits in the `integer` column. */
const esIdDeBarco = (valor: unknown): valor is number =>
  typeof valor === 'number' && Number.isInteger(valor) && valor > 0 && valor <= ID_MAXIMO

/** The ids the rest of the action works with: the first thing that is looked at, before the session or the database are. */
function validarIdentificadores(entrada: { id: unknown; barcoOdooId: unknown }): void {
  const idValido = typeof entrada.id === 'string' && UUID.test(entrada.id)
  if (!idValido || !esIdDeBarco(entrada.barcoOdooId)) throw new ErrorParaOperario('Esa entrega no es válida. Volvé a abrir el barco.')
}

/** What a move of packages to another barco needs, before the session or the database are looked at. The screen makes sure of it. */
function validarCambioDeBarco(entrada: { id: unknown; barcoOdooId: unknown; barcoDestinoOdooId: unknown; moveLineIds: unknown }): void {
  const idValido = typeof entrada.id === 'string' && UUID.test(entrada.id)
  if (!idValido || !esIdDeBarco(entrada.barcoOdooId) || !esIdDeBarco(entrada.barcoDestinoOdooId)) {
    throw new ErrorParaOperario('Ese cambio de barco no es válido. Volvé a abrir el barco.')
  }
  if (entrada.barcoDestinoOdooId === entrada.barcoOdooId) throw new ErrorParaOperario(MISMO_BARCO)
  if (!Array.isArray(entrada.moveLineIds) || entrada.moveLineIds.length === 0) throw new ErrorParaOperario('Elegí al menos un paquete.')
}

/** What the screen already makes sure of (the button is not enabled without it): this is for whoever calls the action without the screen. */
function validarConfirmacion(
  entrada: { receptorNombre: string; moveLineIds: number[]; firmaDataUrl: string },
): string {
  const receptor = typeof entrada.receptorNombre === 'string' ? entrada.receptorNombre.trim() : ''
  if (receptor === '') throw new ErrorParaOperario('Falta el nombre de quien recibe.')
  if (receptor.length > MAX_NOMBRE_RECEPTOR) throw new ErrorParaOperario('El nombre de quien recibe es demasiado largo.')
  // An entrega with no lines would be "registered" and then do nothing in Odoo.
  if (!Array.isArray(entrada.moveLineIds) || entrada.moveLineIds.length === 0) throw new ErrorParaOperario('Elegí al menos un paquete.')
  if (typeof entrada.firmaDataUrl !== 'string' || !FIRMA_PNG.test(entrada.firmaDataUrl)) throw new ErrorParaOperario('Falta la firma.')
  return receptor
}

/**
 * What Odoo has waiting for the barco in the delivery type of the almacén: the one read of Odoo this action makes, outside
 * the queue. When it cannot be read, the operario is told so and the phone keeps everything for a retry.
 */
async function leerPendientes(almacen: Almacen, barcoOdooId: number): Promise<LineaEntrega[]> {
  if (!almacen.odooOutTypeId) {
    throw new ConfiguracionError('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')
  }
  try {
    return await getLineasEntregaPendiente({ outTypeId: almacen.odooOutTypeId, barcoOdooId })
  } catch (error) {
    const mensaje = mensajeDeLecturaFallida(error)
    if (mensaje === null) throw error
    throw new ErrorParaOperario(mensaje)
  }
}

/**
 * The lines of the request that can be delivered or moved, the deliveries they are on and the packages they are: those
 * that Odoo has waiting for the barco in the almacén, and that no other entrega or reasignación on its way to Odoo has
 * taken. The one being confirmed is left out of that second check, so that a retry of it is not blocked by its own lines.
 */
async function lineasAceptadas(
  almacen: Almacen,
  entrada: { id: string; barcoOdooId: number; moveLineIds: number[] },
): Promise<{ moveLineIds: number[]; pickingIds: number[]; paquetes: PaqueteDeOdoo[] }> {
  const [pendientes, retenidas] = await Promise.all([
    leerPendientes(almacen, entrada.barcoOdooId),
    lineasRetenidas({ almacenId: almacen.id, barcoOdooId: entrada.barcoOdooId, exceptoId: entrada.id }),
  ])
  return resolverElegidas({ pedidas: entrada.moveLineIds, pendientes, retenidas })
}

/**
 * Registers the entrega the crew confirmed and queues it. `id` is made up by the phone before its first try and is
 * what makes a retry harmless: the domain saves the entrega once per id, whatever the number of tries.
 *
 * Of what the phone sends, the packages are only ids: the entrega takes the ones that Odoo has waiting for the barco in
 * the active almacén, and the deliveries it touches are the ones those lines are on. A retry of an entrega that was
 * already saved is not checked again: what it holds may be delivered by now, and the domain does nothing with a second one.
 */
export async function confirmarEntregaAction(entrada: {
  id: string
  barcoOdooId: number
  moveLineIds: number[]
  receptorNombre: string
  firmaDataUrl: string
}): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    validarIdentificadores(entrada)
    const operario = await requireOperarioFromCookies()
    const almacen = await requireAlmacenActivo(operario.id)
    const receptorNombre = validarConfirmacion(entrada)

    // A retry finds its entrega saved: nothing of what it sends is used, so nothing of it is given to the domain.
    const lineas = await sesionGuardada({ id: entrada.id, tipo: 'entrega', almacenId: almacen.id })
      ? { moveLineIds: [], pickingIds: [], paquetes: [] }
      : await lineasAceptadas(almacen, entrada)

    // Field by field: the operario and the almacén are the ones of the session, whatever else the client sent along.
    await registrarEntrega({
      id: entrada.id,
      operarioId: operario.id,
      almacenId: almacen.id,
      barcoOdooId: entrada.barcoOdooId,
      pickingIds: lineas.pickingIds,
      moveLineIds: lineas.moveLineIds,
      paquetes: lineas.paquetes,
      receptorNombre,
      firmaBase64: entrada.firmaDataUrl,
    })
    // Nothing is revalidated here, on purpose. Next re-renders the route the action was called from (the barco page)
    // whatever path is revalidated, and the phone is about to say "Entrega registrada" there: the re-render reads Odoo
    // again, its lines have changed, and the flow would remount (back at the packages, with a fresh id) before it could.
    // The list of Entrega is a dynamic page that the client does not cache, so going back to it reads it afresh.
  })
}

/**
 * Registers the move of packages of the barco to another one, in the active almacén, and queues it: the worker is the one
 * that moves them in Odoo. `id` is made up by the phone before its first try, as for an entrega, and makes a retry harmless.
 *
 * Of what the phone sends, the packages are only ids: they are taken from what Odoo has waiting for the barco in the
 * almacén, as for an entrega, and the barco they go to has to be one the search of barcos offers. A retry of one that was
 * already saved is not checked again: what it holds may be moved by now, and the domain does nothing with a second one.
 *
 * The answer brings the barco drawn again (`refresh`): without the packages that are being moved, and saying where they go.
 */
export async function moverPaquetesAction(entrada: {
  id: string
  barcoOdooId: number
  barcoDestinoOdooId: number
  moveLineIds: number[]
}): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    validarCambioDeBarco(entrada)
    const operario = await requireOperarioFromCookies()
    const almacen = await requireAlmacenActivo(operario.id)

    const guardada = await sesionGuardada({ id: entrada.id, tipo: 'reasignacion', almacenId: almacen.id })
    if (!guardada && !(await barcoActivo(entrada.barcoDestinoOdooId))) throw new ErrorParaOperario(BARCO_DESTINO_DESCONOCIDO)
    const lineas = guardada ? { moveLineIds: [], pickingIds: [], paquetes: [] } : await lineasAceptadas(almacen, entrada)

    // Field by field: the operario and the almacén are the ones of the session, whatever else the client sent along.
    await registrarReasignacion({
      id: entrada.id,
      operarioId: operario.id,
      almacenId: almacen.id,
      barcoOdooId: entrada.barcoOdooId,
      barcoDestinoOdooId: entrada.barcoDestinoOdooId,
      ...lineas,
    })
    refresh()
  })
}

/**
 * Sends the open recepciones of the barco in the active almacén, so that the packages they hold get to Odoo and can be
 * delivered. It says how many recepciones it sent.
 */
export async function enviarRecepcionesDelBarcoAction(barcoOdooId: number): Promise<ResultadoAccion<{ enviadas: number }>> {
  return ejecutarAccion(async () => {
    const operario = await requireOperarioFromCookies()
    const almacen = await requireAlmacenActivo(operario.id)
    try {
      const enviadas = await enviarRecepcionesAbiertas({ almacenId: almacen.id, operarioId: operario.id, barcoOdooId })
      return { enviadas }
    } finally {
      // Also when it stops halfway: the recepciones sent before the failure are not open, nor unsent, any more.
      revalidatePath('/entrega')
      revalidatePath('/recepcion')
      // And the barco this is called from comes drawn again in the answer, with what is still unsent: the screen does
      // not ask for it again (EntregaFlow). Said apart because the page is not '/entrega', and Next means to re-render
      // only the paths revalidated.
      refresh()
    }
  })
}
