/*
 * A small Odoo of deliveries, for the tests of the reasignación: the pickings, moves and move lines of the deliveries of
 * the barcos, and what the reasignación asks of them through `odooCall`, answered as Odoo answers it. It also does what
 * Odoo would do if it were asked otherwise, so that a test can tell: lowering the demand of a move below what it has
 * reserved unreserves the whole move (unless the context says `do_not_unreserve`), a draft move put on a picking is
 * confirmed and merged into a move of the same product (`_autoconfirm_picking`), and cancelling a picking that still has
 * moves cancels them.
 */

/** The delivery type of the almacén of the tests (MB92 delivers with operation type 2). */
export const TIPO_DE_ENTREGA = 2

export interface PickingFalso {
  id: number
  name: string
  tipo: number
  barco: number | null
  origin: string | null
  /** Set once it is validated or cancelled; until then its state comes from its moves, as in Odoo. */
  cerrado: 'done' | 'cancel' | null
  notas: string[]
}

export interface MovimientoFalso {
  id: number
  picking: number | null
  producto: number
  demanda: number
  state: string
  origenes: number[]
  /** What the reasignación copies to the part of a move it splits off, kept as it was given. */
  extra: Record<string, unknown>
}

export interface LineaFalsa {
  id: number
  picking: number | null
  movimiento: number | null
  lote: string | null
  cantidad: number
}

/** A call the code made, in the order it made it. */
export interface Llamada {
  modelo: string
  metodo: string
  params: Record<string, unknown>
}

type Condicion = [string, string, unknown]
type Comando = [number, number, unknown?]

/** The fields a move of a delivery has, as Odoo reads them: the ones the reasignación copies when it splits a move. */
const EXTRA_DE_UN_MOVIMIENTO = {
  company_id: 1,
  location_id: 8,
  location_dest_id: 5,
  picking_type_id: TIPO_DE_ENTREGA,
  procure_method: 'make_to_order',
  origin: 'MB92/IN/00231',
  description_picking: false,
}

/** What an Odoo that took too long to answer, after doing the work, makes `fetch` throw. */
function corteDeConexion(): Error {
  return Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
}

const ESCRITURAS = new Set(['create', 'write', 'action_cancel', 'message_post'])

export class OdooDeEntregas {
  readonly pickings = new Map<number, PickingFalso>()
  readonly movimientos = new Map<number, MovimientoFalso>()
  readonly lineas = new Map<number, LineaFalsa>()
  readonly llamadas: Llamada[] = []
  /** After this many writes, the next one is done and its answer lost: how a run is cut in the middle. */
  cortarTrasEscrituras: number | null = null
  /** A move created with a state keeps it unless this is set: then it is born a draft, as if Odoo ignored the state. */
  ignorarEstadoAlCrear = false
  private escrituras = 0
  private siguienteId = 5000

  constructor(private readonly barcoField: string) {}

  private nuevoId(): number {
    this.siguienteId += 1
    return this.siguienteId
  }

  /** A delivery of `barco`, of the delivery type unless said, waiting to be handed over once it has moves. */
  entrega(datos: { id: number; barco: number | null; tipo?: number; name?: string; origin?: string; cerrado?: PickingFalso['cerrado'] }): PickingFalso {
    const picking: PickingFalso = {
      id: datos.id,
      name: datos.name ?? `MB92/OUT/${String(datos.id).padStart(5, '0')}`,
      tipo: datos.tipo ?? TIPO_DE_ENTREGA,
      barco: datos.barco,
      origin: datos.origin ?? null,
      cerrado: datos.cerrado ?? null,
      notas: [],
    }
    this.pickings.set(picking.id, picking)
    return picking
  }

  /**
   * A move on `picking`, reserved, with one line per package: `lineas` are the ids of its lines and `lotes` their
   * packages (null for a line without lot). Its demand is what it reserved, unless `demanda` says otherwise.
   */
  movimiento(datos: {
    id: number
    picking: number
    lineas: number[]
    lotes?: Array<string | null>
    producto?: number
    origenes?: number[]
    demanda?: number
  }): MovimientoFalso {
    const movimiento: MovimientoFalso = {
      id: datos.id,
      picking: datos.picking,
      producto: datos.producto ?? 11,
      demanda: datos.demanda ?? datos.lineas.length,
      state: 'assigned',
      origenes: datos.origenes ?? [datos.id - 100],
      extra: { ...EXTRA_DE_UN_MOVIMIENTO },
    }
    this.movimientos.set(movimiento.id, movimiento)
    datos.lineas.forEach((id, posicion) => {
      const lote = datos.lotes === undefined ? `T${id}` : datos.lotes[posicion]
      this.lineas.set(id, { id, picking: datos.picking, movimiento: movimiento.id, lote, cantidad: 1 })
    })
    return movimiento
  }

  /** The moves of a picking, by id. */
  movimientosDe(pickingId: number): MovimientoFalso[] {
    return [...this.movimientos.values()].filter((movimiento) => movimiento.picking === pickingId).sort((a, b) => a.id - b.id)
  }

  /** The lines of a picking, by id. */
  lineasDe(pickingId: number): LineaFalsa[] {
    return [...this.lineas.values()].filter((linea) => linea.picking === pickingId).sort((a, b) => a.id - b.id)
  }

  cantidadDe(movimientoId: number): number {
    return [...this.lineas.values()].filter((linea) => linea.movimiento === movimientoId).reduce((total, linea) => total + linea.cantidad, 0)
  }

  /** The state of a picking as Odoo computes it: none of its moves, or one in draft, make it a draft. */
  estadoDe(pickingId: number): string {
    const picking = this.pickings.get(pickingId) as PickingFalso
    if (picking.cerrado) return picking.cerrado
    const movimientos = this.movimientosDe(pickingId)
    if (movimientos.length === 0 || movimientos.some((movimiento) => movimiento.state === 'draft')) return 'draft'
    if (movimientos.every((movimiento) => movimiento.state === 'cancel')) return 'cancel'
    return 'assigned'
  }

  /** The writes the code made, in order. */
  escriturasHechas(): Llamada[] {
    return this.llamadas.filter((llamada) => ESCRITURAS.has(llamada.metodo))
  }

  private campoDePicking(picking: PickingFalso, campo: string): unknown {
    switch (campo) {
      case 'id': return picking.id
      case 'name': return picking.name
      case 'state': return this.estadoDe(picking.id)
      case 'picking_type_id': return picking.tipo
      case 'origin': return picking.origin ?? false
      case 'move_ids': return this.movimientosDe(picking.id).map((movimiento) => movimiento.id)
      default:
        if (campo === this.barcoField) return picking.barco ?? false
        throw new Error(`The Odoo of the tests does not know the field ${campo} of a picking`)
    }
  }

  private campoDeLinea(linea: LineaFalsa, campo: string): unknown {
    if (campo.startsWith('picking_id.')) {
      const picking = linea.picking === null ? undefined : this.pickings.get(linea.picking)
      return picking ? this.campoDePicking(picking, campo.slice('picking_id.'.length)) : false
    }
    switch (campo) {
      case 'id': return linea.id
      case 'lot_id.name': return linea.lote ?? false
      default: throw new Error(`The Odoo of the tests does not know the field ${campo} of a line`)
    }
  }

  /** Whether a record meets a domain: its conditions, joined by `&` unless `|` or `&` say otherwise, in prefix order. */
  private cumple(valorDe: (campo: string) => unknown, dominio: unknown[]): boolean {
    let posicion = 0
    const siguiente = (): boolean => {
      const elemento = dominio[posicion++]
      if (elemento === '|') {
        const a = siguiente()
        const b = siguiente()
        return a || b
      }
      if (elemento === '&') {
        const a = siguiente()
        const b = siguiente()
        return a && b
      }
      const [campo, operador, valor] = elemento as Condicion
      const actual = valorDe(campo)
      const igual = (otro: unknown) => (Array.isArray(actual) ? (otro === false ? actual.length === 0 : false) : actual === otro)
      switch (operador) {
        case '=': return igual(valor)
        case '!=': return !igual(valor)
        case 'in': return (valor as unknown[]).some(igual)
        case 'not in': return !(valor as unknown[]).some(igual)
        default: throw new Error(`The Odoo of the tests does not know the operator ${operador}`)
      }
    }
    let todas = true
    while (posicion < dominio.length) todas = siguiente() && todas
    return todas
  }

  private leerPicking(picking: PickingFalso, campos: string[]): Record<string, unknown> {
    const fila: Record<string, unknown> = { id: picking.id }
    for (const campo of campos) {
      if (campo === 'picking_type_id') fila[campo] = [picking.tipo, 'MB92: Entregas']
      else if (campo === this.barcoField) fila[campo] = picking.barco === null ? false : [picking.barco, `Barco ${picking.barco}`]
      else fila[campo] = this.campoDePicking(picking, campo)
    }
    return fila
  }

  private leerLinea(linea: LineaFalsa, campos: string[]): Record<string, unknown> {
    const valores: Record<string, unknown> = {
      picking_id: linea.picking === null ? false : [linea.picking, this.pickings.get(linea.picking)?.name ?? '?'],
      move_id: linea.movimiento === null ? false : [linea.movimiento, 'Movimiento'],
      lot_id: linea.lote === null ? false : [linea.id + 90_000, linea.lote],
      quantity: linea.cantidad,
    }
    return Object.fromEntries([['id', linea.id], ...campos.map((campo) => [campo, valores[campo]])])
  }

  private leerMovimiento(movimiento: MovimientoFalso, campos: string[]): Record<string, unknown> {
    const muchos = (id: unknown) => (typeof id === 'number' ? [id, `#${id}`] : false)
    const valores: Record<string, unknown> = {
      picking_id: movimiento.picking === null ? false : [movimiento.picking, this.pickings.get(movimiento.picking)?.name ?? '?'],
      state: movimiento.state,
      product_uom_qty: movimiento.demanda,
      quantity: this.cantidadDe(movimiento.id),
      move_line_ids: [...this.lineas.values()].filter((linea) => linea.movimiento === movimiento.id).map((linea) => linea.id),
      move_orig_ids: movimiento.origenes,
      product_id: [movimiento.producto, 'DHL'],
      company_id: muchos(movimiento.extra.company_id),
      location_id: muchos(movimiento.extra.location_id),
      location_dest_id: muchos(movimiento.extra.location_dest_id),
      picking_type_id: muchos(movimiento.extra.picking_type_id),
      procure_method: movimiento.extra.procure_method ?? false,
      origin: movimiento.extra.origin ?? false,
      description_picking: movimiento.extra.description_picking ?? false,
    }
    return Object.fromEntries([['id', movimiento.id], ...campos.map((campo) => [campo, valores[campo]])])
  }

  /** A move created by a command on a picking: its fields as they came, its lines taken from the moves they were on. */
  private crearMovimiento(pickingId: number, vals: Record<string, unknown>): void {
    const { product_id, product_uom_qty, state, move_orig_ids, move_line_ids, ...extra } = vals
    const origenes = (move_orig_ids as Comando[] | undefined)?.flatMap((comando) => (comando[0] === 6 ? (comando[2] as number[]) : [])) ?? []
    const movimiento: MovimientoFalso = {
      id: this.nuevoId(),
      picking: pickingId,
      producto: product_id as number,
      demanda: product_uom_qty as number,
      state: this.ignorarEstadoAlCrear ? 'draft' : ((state as string | undefined) ?? 'draft'),
      origenes,
      extra,
    }
    this.movimientos.set(movimiento.id, movimiento)
    for (const comando of (move_line_ids as Comando[] | undefined) ?? []) {
      if (comando[0] !== 4) throw new Error(`The Odoo of the tests only links lines to a new move, not ${comando[0]}`)
      const linea = this.lineas.get(comando[1]) as LineaFalsa
      linea.movimiento = movimiento.id
    }
  }

  /** `stock.move.write` of a demand: below what the move has reserved, Odoo unreserves it all unless told not to. */
  private cambiarDemanda(movimientoId: number, demanda: number, contexto: Record<string, unknown>): void {
    const movimiento = this.movimientos.get(movimientoId) as MovimientoFalso
    if (!contexto.do_not_unreserve && this.cantidadDe(movimientoId) > demanda) {
      for (const linea of [...this.lineas.values()]) {
        if (linea.movimiento === movimientoId) this.lineas.delete(linea.id)
      }
      movimiento.state = 'confirmed'
    }
    movimiento.demanda = demanda
  }

  /** `_autoconfirm_picking`: a draft move with something reserved is confirmed, and merged into a move of the same product. */
  private autoconfirmar(pickingId: number): void {
    for (const borrador of this.movimientosDe(pickingId).filter((movimiento) => movimiento.state === 'draft')) {
      if (this.cantidadDe(borrador.id) === 0) continue
      const gemelo = this.movimientosDe(pickingId).find((movimiento) => movimiento !== borrador && movimiento.producto === borrador.producto)
      if (!gemelo) {
        borrador.state = 'assigned'
        continue
      }
      for (const linea of this.lineas.values()) {
        if (linea.movimiento === borrador.id) linea.movimiento = gemelo.id
      }
      gemelo.demanda += borrador.demanda
      this.movimientos.delete(borrador.id)
    }
  }

  private escribirPicking(pickingId: number, vals: Record<string, unknown>, contexto: Record<string, unknown>): void {
    for (const comando of (vals.move_ids as Comando[] | undefined) ?? []) {
      if (comando[0] === 0) this.crearMovimiento(pickingId, comando[2] as Record<string, unknown>)
      else if (comando[0] === 1) {
        const cambios = comando[2] as Record<string, unknown>
        if ('product_uom_qty' in cambios) this.cambiarDemanda(comando[1], cambios.product_uom_qty as number, contexto)
      } else if (comando[0] === 4) (this.movimientos.get(comando[1]) as MovimientoFalso).picking = pickingId
      else throw new Error(`The Odoo of the tests does not know the command ${comando[0]} on move_ids`)
    }
    for (const comando of (vals.move_line_ids as Comando[] | undefined) ?? []) {
      if (comando[0] !== 4) throw new Error(`The Odoo of the tests does not know the command ${comando[0]} on move_line_ids`)
      ;(this.lineas.get(comando[1]) as LineaFalsa).picking = pickingId
    }
    if (vals.move_ids) this.autoconfirmar(pickingId)
  }

  /** What Odoo answers to `odooCall(modelo, metodo, params)`. */
  responder(modelo: string, metodo: string, params: Record<string, unknown> = {}): unknown {
    this.llamadas.push({ modelo, metodo, params })
    const respuesta = this.hacer(modelo, metodo, params)
    if (ESCRITURAS.has(metodo)) {
      this.escrituras += 1
      if (this.cortarTrasEscrituras !== null && this.escrituras > this.cortarTrasEscrituras) {
        this.cortarTrasEscrituras = null
        throw corteDeConexion()
      }
    }
    return respuesta
  }

  private hacer(modelo: string, metodo: string, params: Record<string, unknown>): unknown {
    const { domain = [], fields = [], ids = [], vals = {}, context = {} } = params as {
      domain?: unknown[]; fields?: string[]; ids?: number[]; vals?: Record<string, unknown>; context?: Record<string, unknown>
    }
    const porId = <T extends { id: number }>(registros: Iterable<T>) => [...registros].sort((a, b) => a.id - b.id)

    if (modelo === 'stock.move.line' && metodo === 'search_read') {
      return porId(this.lineas.values())
        .filter((linea) => this.cumple((campo) => this.campoDeLinea(linea, campo), domain))
        .map((linea) => this.leerLinea(linea, fields))
    }
    if (modelo === 'stock.move' && metodo === 'search_read') {
      return porId(this.movimientos.values())
        .filter((movimiento) => this.cumple((campo) => {
          if (campo !== 'id') throw new Error(`The Odoo of the tests does not know the field ${campo} of a move`)
          return movimiento.id
        }, domain))
        .map((movimiento) => this.leerMovimiento(movimiento, fields))
    }
    if (modelo !== 'stock.picking') throw new Error(`The Odoo of the tests does not know ${modelo}.${metodo}`)

    switch (metodo) {
      case 'search_read':
        return porId(this.pickings.values())
          .filter((picking) => this.cumple((campo) => this.campoDePicking(picking, campo), domain))
          .map((picking) => this.leerPicking(picking, fields))
      case 'read':
        return ids.flatMap((id) => {
          const picking = this.pickings.get(id)
          return picking ? [this.leerPicking(picking, fields)] : []
        })
      case 'create': {
        const [valores] = params.vals_list as Array<Record<string, unknown>>
        const picking = this.entrega({
          id: this.nuevoId(),
          tipo: valores.picking_type_id as number,
          barco: (valores[this.barcoField] as number | undefined) ?? null,
          origin: valores.origin as string | undefined,
        })
        return picking.id
      }
      case 'write':
        for (const id of ids) this.escribirPicking(id, vals, context)
        return true
      case 'action_cancel':
        for (const id of ids) {
          for (const movimiento of this.movimientosDe(id)) movimiento.state = 'cancel'
          ;(this.pickings.get(id) as PickingFalso).cerrado = 'cancel'
        }
        return true
      case 'message_post':
        for (const id of ids) (this.pickings.get(id) as PickingFalso).notas.push(params.body as string)
        return true
      default:
        throw new Error(`The Odoo of the tests does not know stock.picking.${metodo}`)
    }
  }
}
