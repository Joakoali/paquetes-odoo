import { RespuestaOdooInesperadaError } from '../errores'
import { odooCall } from './client'
import { campoBarco, dominioEntregasPendientes, enSuPicking, firstId, type Condicion, type Many2one } from './pickings'

/*
 * How Odoo moves packages that wait for delivery from the barco they were received for to another barco of the same
 * almacén: the only place that knows it. The worker says what to move and where to; this reads what Odoo has now and does
 * what is left of it, so that a retry picks the work up where the last attempt stopped.
 *
 * A package is a line of a move, and a move holds every package of one courier that came in one recepción. A move whose
 * lines all go is handed over whole, as the cron of Odoo does when it merges the deliveries of a barco. A move that only
 * some of its lines leave is split first, on the delivery it is on. Each write is one request, so one transaction of Odoo,
 * and leaves every delivery whole whatever happens after it: nothing is ever half moved.
 *
 * Nothing is deleted: a delivery that is left with nothing is cancelled, as the cron does.
 */

/** What the deliveries the webapp makes to take moved packages say, when the barco had none waiting: a retry finds them by it. */
export const ORIGEN_CAMBIO_DE_BARCO = 'Webapp: cambio de barco'

/** Odoo's quantities are floats: below this two of them are the same. */
const TOLERANCIA = 1e-6

/** The states a delivery that still waits to be handed over can be in: what `dominioEntregasPendientes` lets through. */
const NO_PENDIENTE = ['draft', 'done', 'cancel']

/** A package to move: its line, and its package, by which it is found if the line is not there any more. */
export interface PaqueteAMover {
  moveLineId: number
  /** Null for a line without lot, which can only be found by its id. */
  trackingNumber: string | null
}

/** A delivery: its id and its name, e.g. `MB92/OUT/00512`. */
export interface EntregaDeOdoo {
  id: number
  ref: string
}

interface LineaRead {
  id: number
  picking_id: Many2one
  move_id: Many2one
  lot_id: Many2one
  quantity: number
}

const CAMPOS_LINEA = ['picking_id', 'move_id', 'lot_id', 'quantity']

/** A picking as the reasignación reads it. Its barco is under the key that `ODOO_FIELD_BARCO` names, hence the index signature. */
interface PickingRead {
  id: number
  name: string
  state: string
  picking_type_id: Many2one
  move_ids: number[]
  [campo: string]: unknown
}

/** A move as the reasignación reads it: what says whether it can be split, and what the part of it that goes is made of. */
interface MovimientoRead {
  id: number
  picking_id: Many2one
  state: string
  product_uom_qty: number
  quantity: number
  move_line_ids: number[]
  move_orig_ids: number[]
  company_id: Many2one
  product_id: Many2one
  location_id: Many2one
  location_dest_id: Many2one
  picking_type_id: Many2one
  procure_method: string | false
  origin: string | false
  description_picking: string | false
}

const CAMPOS_MOVIMIENTO = [
  'picking_id', 'state', 'product_uom_qty', 'quantity', 'move_line_ids', 'move_orig_ids', 'company_id', 'product_id',
  'location_id', 'location_dest_id', 'picking_type_id', 'procure_method', 'origin', 'description_picking',
]

/** The part of a move that goes to the other barco: the move, and those of its lines that go. */
interface Particion {
  movimiento: MovimientoRead
  lineas: LineaRead[]
}

/** The packages that leave one delivery of the barco: what the worker notes in it. */
export interface SalidaDeUnaEntrega {
  entrega: EntregaDeOdoo
  /** Each package as Odoo names it, null for a line without lot. */
  trackingNumbers: Array<string | null>
}

/** What is left to do to move the packages, as `planearReasignacion` found it: what `aplicarReasignacion` does. */
export interface PlanDeReasignacion {
  /** The moves only some of whose lines go, by the delivery they are on: they are split there first. */
  particiones: Map<number, Particion[]>
  /** The moves all of whose lines go. */
  movimientosEnteros: number[]
  /** Every line that goes. None when an earlier attempt moved them all. */
  lineas: number[]
  /** What leaves each delivery, the lines that go grouped by the delivery they are on. */
  salidas: SalidaDeUnaEntrega[]
  /**
   * The deliveries of the barco that are left with nothing once the lines go, or that an earlier attempt left so: those
   * that are empty when it comes to it are cancelled at the end.
   */
  aCancelar: EntregaDeOdoo[]
}

/** The id of a Many2one that is set. Every Many2one read through this is one Odoo always sets on these records. */
function idDe(valor: Many2one): number {
  if (!valor) throw new RespuestaOdooInesperadaError('Odoo devolvió un paquete o un movimiento incompleto. No se movió nada.')
  return valor[0]
}

/** The barco of a picking, by its id, or null when it has none. */
function barcoDe(picking: PickingRead, barcoField: string): number | null {
  const barco = picking[barcoField] as Many2one | undefined
  return barco ? barco[0] : null
}

/** How a package is named in a message: its number, or "sin número". */
const nombreDePaquete = (linea: Pick<LineaRead, 'lot_id'>) => (linea.lot_id ? linea.lot_id[1] : 'sin número')

/**
 * The lines of the packages: by their id and, for one whose line is gone, by its package on a delivery of either barco.
 * A line Odoo makes again keeps its package: a delivery validated with the line left in depósito puts it in a backorder
 * under another id, and so may a delivery of the destino an earlier attempt moved it to.
 */
async function leerLineas(entrada: {
  paquetes: PaqueteAMover[]
  outTypeId: number
  barcos: [origen: number, destino: number]
  barcoField: string
}): Promise<LineaRead[]> {
  const { paquetes, outTypeId, barcos, barcoField } = entrada
  const ids = [...new Set(paquetes.map((paquete) => paquete.moveLineId))]
  const porId = await odooCall<LineaRead[]>('stock.move.line', 'search_read', {
    domain: [['id', 'in', ids]],
    fields: CAMPOS_LINEA,
  })

  const encontradas = new Set(porId.map((linea) => linea.id))
  const faltan = paquetes.filter((paquete) => !encontradas.has(paquete.moveLineId))
  if (faltan.length === 0) return porId

  const sinNumero = faltan.filter((paquete) => paquete.trackingNumber === null).length
  if (sinNumero > 0) {
    throw new RespuestaOdooInesperadaError(
      `${sinNumero} paquete(s) sin número ya no están en Odoo. No se movió nada: revisá la entrega en Odoo antes de reintentar.`,
    )
  }

  const lotes = [...new Set(faltan.map((paquete) => paquete.trackingNumber as string))]
  const porLote = await odooCall<LineaRead[]>('stock.move.line', 'search_read', {
    domain: [
      ...enSuPicking([...dominioEntregasPendientes(outTypeId, barcoField), [barcoField, 'in', barcos]]),
      ['lot_id.name', 'in', lotes],
    ],
    fields: CAMPOS_LINEA,
  })
  const lineasDelLote = new Map<string, LineaRead[]>()
  for (const linea of porLote) {
    if (!linea.lot_id) continue
    lineasDelLote.set(linea.lot_id[1], [...(lineasDelLote.get(linea.lot_id[1]) ?? []), linea])
  }

  // A package is in one place at a time: none means it left the barco some other way, two that Odoo has it twice.
  const noEncontrados = lotes.filter((lote) => lineasDelLote.get(lote)?.length !== 1)
  if (noEncontrados.length > 0) {
    throw new RespuestaOdooInesperadaError(
      `${noEncontrados.length} paquete(s) ya no están esperando entrega en Odoo: ${noEncontrados.join(', ')}. `
        + 'No se movió nada: revisalos en Odoo antes de reintentar.',
    )
  }
  return [...porId, ...lotes.map((lote) => (lineasDelLote.get(lote) as LineaRead[])[0])]
}

/**
 * What is left to do to move the packages from the barco `barcoOrigenOdooId` to `barcoDestinoOdooId`, in the delivery
 * type `outTypeId` of the almacén. It only reads: three requests, four when a line has to be found by its package.
 *
 * Each package is in one of two places: on a delivery of the origen waiting to be handed over (it goes), or on a delivery
 * of the destino (an earlier attempt moved it: nothing to do). Anywhere else (delivered, cancelled, on another barco or in
 * another almacén) is something nobody asked for, and it throws, before anything is written: no package is moved unless
 * all of them can be. So does a move with demand that is not reserved, which moving or splitting would leave as a
 * phantom line on one of the barcos.
 *
 * `entregasOrigenIds` are the deliveries the packages were on when the reasignación was confirmed: one that an earlier
 * attempt left with nothing is cancelled too.
 */
export async function planearReasignacion(entrada: {
  paquetes: PaqueteAMover[]
  outTypeId: number
  barcoOrigenOdooId: number
  barcoDestinoOdooId: number
  entregasOrigenIds: number[]
}): Promise<PlanDeReasignacion> {
  const { outTypeId, barcoOrigenOdooId, barcoDestinoOdooId } = entrada
  const barcoField = campoBarco()

  const lineas = await leerLineas({
    paquetes: entrada.paquetes, outTypeId, barcos: [barcoOrigenOdooId, barcoDestinoOdooId], barcoField,
  })
  const pickingIds = new Set([
    ...lineas.flatMap((linea) => (linea.picking_id ? [linea.picking_id[0]] : [])),
    ...entrada.entregasOrigenIds,
  ])
  const pickings = new Map((await odooCall<PickingRead[]>('stock.picking', 'search_read', {
    domain: [['id', 'in', [...pickingIds]]],
    fields: ['name', 'state', 'picking_type_id', 'move_ids', barcoField],
  })).map((picking) => [picking.id, picking]))

  const deEstaEntrega = (picking: PickingRead | undefined, barcoOdooId: number): picking is PickingRead => picking !== undefined
    && picking.picking_type_id !== false && picking.picking_type_id[0] === outTypeId && barcoDe(picking, barcoField) === barcoOdooId
  const pickingDe = (linea: LineaRead) => (linea.picking_id ? pickings.get(linea.picking_id[0]) : undefined)

  const porMover: LineaRead[] = []
  const enOtroLado: LineaRead[] = []
  for (const linea of lineas) {
    const picking = pickingDe(linea)
    if (deEstaEntrega(picking, barcoOrigenOdooId) && !NO_PENDIENTE.includes(picking.state)) porMover.push(linea)
    else if (!(deEstaEntrega(picking, barcoDestinoOdooId) && picking.state !== 'cancel')) enOtroLado.push(linea)
  }
  if (enOtroLado.length > 0) {
    throw new RespuestaOdooInesperadaError(
      `${enOtroLado.length} paquete(s) ya no están esperando entrega de este barco en Odoo: ${enOtroLado.map(nombreDePaquete).join(', ')}. `
        + 'No se movió nada: revisalos en Odoo antes de reintentar.',
    )
  }

  const movimientos = porMover.length === 0 ? new Map<number, MovimientoRead>() : new Map(
    (await odooCall<MovimientoRead[]>('stock.move', 'search_read', {
      domain: [['id', 'in', [...new Set(porMover.map((linea) => idDe(linea.move_id)))]]],
      fields: CAMPOS_MOVIMIENTO,
    })).map((movimiento) => [movimiento.id, movimiento]),
  )

  // The lines that go, by their move: a move all of whose lines go is moved whole, any other is split.
  const porMovimiento = new Map<number, LineaRead[]>()
  for (const linea of porMover) {
    const moveId = idDe(linea.move_id)
    porMovimiento.set(moveId, [...(porMovimiento.get(moveId) ?? []), linea])
  }

  const particiones = new Map<number, Particion[]>()
  const movimientosEnteros: number[] = []
  for (const [moveId, suyas] of porMovimiento) {
    const movimiento = movimientos.get(moveId)
    const pickingId = suyas[0].picking_id ? suyas[0].picking_id[0] : null
    // A line on one delivery whose move is on another is something somebody left half done in Odoo.
    if (!movimiento || !movimiento.picking_id || movimiento.picking_id[0] !== pickingId || NO_PENDIENTE.includes(movimiento.state)) {
      throw new RespuestaOdooInesperadaError(
        `El movimiento de ${suyas.map(nombreDePaquete).join(', ')} no está en su entrega. No se movió nada: revisalo en Odoo antes de reintentar.`,
      )
    }
    if (Math.abs(movimiento.product_uom_qty - movimiento.quantity) > TOLERANCIA) {
      throw new RespuestaOdooInesperadaError(
        `Odoo tiene a medio reservar el movimiento de ${suyas.map(nombreDePaquete).join(', ')} `
          + `(${movimiento.product_uom_qty} pedidos, ${movimiento.quantity} reservados). No se movió nada: revisalo en Odoo antes de reintentar.`,
      )
    }

    const queSeVan = new Set(suyas.map((linea) => linea.id))
    if (movimiento.move_line_ids.every((linea) => queSeVan.has(linea))) {
      movimientosEnteros.push(moveId)
    } else {
      const delPicking = particiones.get(movimiento.picking_id[0]) ?? []
      particiones.set(movimiento.picking_id[0], [...delPicking, { movimiento, lineas: suyas }])
    }
  }

  // What leaves each delivery, in the order of its first package.
  const salidas = new Map<number, SalidaDeUnaEntrega>()
  for (const linea of porMover) {
    const picking = pickingDe(linea) as PickingRead
    const salida = salidas.get(picking.id) ?? { entrega: { id: picking.id, ref: picking.name }, trackingNumbers: [] }
    salida.trackingNumbers.push(linea.lot_id ? linea.lot_id[1] : null)
    salidas.set(picking.id, salida)
  }

  // A delivery of the origen is left with nothing when every move it has goes whole. One with no move at all was emptied
  // by an earlier attempt, and an empty picking is a draft in Odoo, so drafts count here.
  const enteros = new Set(movimientosEnteros)
  const aCancelar = [...new Set([...salidas.keys(), ...entrada.entregasOrigenIds])].flatMap((id) => {
    const picking = pickings.get(id)
    if (!deEstaEntrega(picking, barcoOrigenOdooId) || ['done', 'cancel'].includes(picking.state)) return []
    return picking.move_ids.every((moveId) => enteros.has(moveId)) ? [{ id: picking.id, ref: picking.name }] : []
  })

  return {
    particiones,
    movimientosEnteros,
    lineas: porMover.map((linea) => linea.id),
    salidas: [...salidas.values()],
    aCancelar,
  }
}

/**
 * The commands that split a move on its delivery: a new move takes the lines that go, and the demand of the move comes
 * down to what it keeps. In this order: once the new move has taken the lines, the move reserves exactly what it is asked
 * for. The other way round, a demand below what it has reserved would make Odoo unreserve the whole move, which is also
 * what `do_not_unreserve` in the context of the write is there to stop.
 *
 * The new move is born reserved, with the lines it takes: a draft move would be confirmed by Odoo on the same write, and
 * merged back into the move it came from. It comes from the same moves (`move_orig_ids`, the line of the recepción): if
 * its package is later left in depósito, that is how Odoo knows to reserve that package and no other in the backorder.
 */
function comandosDeParticion({ movimiento, lineas }: Particion): unknown[] {
  const cantidad = lineas.reduce((total, linea) => total + linea.quantity, 0)
  const nuevo = {
    ...(movimiento.company_id ? { company_id: movimiento.company_id[0] } : {}),
    product_id: idDe(movimiento.product_id),
    product_uom_qty: cantidad,
    location_id: idDe(movimiento.location_id),
    location_dest_id: idDe(movimiento.location_dest_id),
    picking_type_id: idDe(movimiento.picking_type_id),
    ...(movimiento.procure_method ? { procure_method: movimiento.procure_method } : {}),
    ...(movimiento.origin ? { origin: movimiento.origin } : {}),
    ...(movimiento.description_picking ? { description_picking: movimiento.description_picking } : {}),
    move_orig_ids: [[6, 0, movimiento.move_orig_ids]],
    state: 'assigned',
    move_line_ids: lineas.map((linea) => [4, linea.id]),
  }
  return [[0, 0, nuevo], [1, movimiento.id, { product_uom_qty: movimiento.product_uom_qty - cantidad }]]
}

/**
 * Does what `plan` says is left: splits the moves that only some of their lines leave (one write per delivery of origen),
 * hands every line that goes to `destinoId` with its move (one write, the moves and the lines together, so that a
 * delivery never has a line without its move or the other way round), and cancels the deliveries that are left with
 * nothing. `destinoId` is only needed when there are lines to move. It says which deliveries it cancelled.
 *
 * A split is checked before anything is handed over: each line that was split off has to be on a move that is not one of
 * those that were read. If Odoo had put it back into one of them, handing that move over would take packages that stay.
 *
 * A delivery is cancelled only if it has no move when it comes to it, which is asked of Odoo then and not taken from the
 * plan: the cron of Odoo may have merged the packages of a new recepción into it since it was read, and cancelling it
 * would cancel them too. Once empty it is a draft, which the cron never merges into, so it stays empty until cancelled.
 */
export async function aplicarReasignacion(
  plan: PlanDeReasignacion,
  destinoId: number | null,
): Promise<{ canceladas: EntregaDeOdoo[] }> {
  const movimientos = [...plan.movimientosEnteros]

  if (plan.particiones.size > 0) {
    for (const [pickingId, particiones] of plan.particiones) {
      await odooCall('stock.picking', 'write', {
        ids: [pickingId],
        vals: { move_ids: particiones.flatMap(comandosDeParticion) },
        context: { do_not_unreserve: true },
      })
    }

    const leidos = new Set([...plan.particiones.values()].flat().map((particion) => particion.movimiento.id))
    const partidas = [...plan.particiones.values()].flat().flatMap((particion) => particion.lineas.map((linea) => linea.id))
    // The write does not say what it made: the moves the split lines are on now are read.
    const releidas = await odooCall<Array<{ id: number; move_id: Many2one }>>('stock.move.line', 'search_read', {
      domain: [['id', 'in', partidas]],
      fields: ['move_id'],
    })
    const nuevos = releidas.map((linea) => (linea.move_id ? linea.move_id[0] : null))
    if (releidas.length !== partidas.length || nuevos.some((moveId) => moveId === null || leidos.has(moveId))) {
      throw new RespuestaOdooInesperadaError(
        'Odoo no separó los paquetes de su movimiento. No se pasó nada al otro barco: revisá la entrega en Odoo antes de reintentar.',
      )
    }
    movimientos.push(...new Set(nuevos as number[]))
  }

  if (plan.lineas.length > 0) {
    if (destinoId === null) throw new Error('A reasignación with lines to move needs the delivery that takes them')
    await odooCall('stock.picking', 'write', {
      ids: [destinoId],
      vals: {
        move_ids: movimientos.map((moveId) => [4, moveId]),
        move_line_ids: plan.lineas.map((lineaId) => [4, lineaId]),
      },
    })
  }

  if (plan.aCancelar.length === 0) return { canceladas: [] }
  const vacias = new Set((await odooCall<Array<{ id: number }>>('stock.picking', 'search_read', {
    domain: [['id', 'in', plan.aCancelar.map((entrega) => entrega.id)], ['move_ids', '=', false], ['state', '!=', 'cancel']],
    fields: ['id'],
  })).map((picking) => picking.id))
  const canceladas = plan.aCancelar.filter((entrega) => vacias.has(entrega.id))
  if (canceladas.length > 0) await odooCall('stock.picking', 'action_cancel', { ids: canceladas.map((entrega) => entrega.id) })
  return { canceladas }
}

/** A domain of Odoo: conditions, and the `|` and `&` that join the two that follow them. */
type Dominio = Array<Condicion | '|' | '&'>

/**
 * The delivery of the barco, in the delivery type `outTypeId`, that takes the moved packages, in this order:
 *
 * - `guardadaId`, the one an earlier attempt took, if it is still of the barco and neither done nor cancelled;
 * - the oldest of the barco that waits to be handed over, as the cron of Odoo picks the one it merges into, so that the
 *   barco keeps one delivery and one albarán;
 * - one the webapp made earlier for this and that is still a draft: the answer to its creation can be lost after Odoo
 *   made it, and it would otherwise stay there empty;
 * - a new one, of the barco, which Odoo gives the locations of the type and a name.
 *
 * One request to look for it, and one more to check the one kept or two to make a new one.
 */
export async function entregaDestino(entrada: {
  outTypeId: number
  barcoOdooId: number
  guardadaId: number | null
}): Promise<EntregaDeOdoo> {
  const { outTypeId, barcoOdooId, guardadaId } = entrada
  const barcoField = campoBarco()

  if (guardadaId !== null) {
    const [guardada] = await odooCall<PickingRead[]>('stock.picking', 'search_read', {
      domain: [['id', '=', guardadaId]],
      fields: ['name', 'state', 'picking_type_id', barcoField],
    })
    const sigueSiendo = guardada !== undefined
      && guardada.picking_type_id !== false && guardada.picking_type_id[0] === outTypeId
      && barcoDe(guardada, barcoField) === barcoOdooId
      && !['done', 'cancel'].includes(guardada.state)
    if (sigueSiendo) return { id: guardada.id, ref: guardada.name }
  }

  const dominio: Dominio = [
    ['picking_type_id', '=', outTypeId],
    [barcoField, '=', barcoOdooId],
    '|', ['state', 'not in', NO_PENDIENTE],
    '&', ['state', '=', 'draft'], ['origin', '=', ORIGEN_CAMBIO_DE_BARCO],
  ]
  const candidatas = await odooCall<Array<{ id: number; name: string; state: string }>>('stock.picking', 'search_read', {
    domain: dominio,
    fields: ['name', 'state'],
    order: 'id asc',
  })
  const elegida = candidatas.find((picking) => picking.state !== 'draft') ?? candidatas[0]
  if (elegida) return { id: elegida.id, ref: elegida.name }

  const id = firstId(await odooCall<number | number[]>('stock.picking', 'create', {
    vals_list: [{ picking_type_id: outTypeId, [barcoField]: barcoOdooId, origin: ORIGEN_CAMBIO_DE_BARCO }],
  }))
  const [creada] = await odooCall<Array<{ name: string }>>('stock.picking', 'read', { ids: [id], fields: ['name'] })
  if (!creada) throw new RespuestaOdooInesperadaError(`Odoo no encuentra la entrega ${id} que acaba de crear.`)
  return { id, ref: creada.name }
}
