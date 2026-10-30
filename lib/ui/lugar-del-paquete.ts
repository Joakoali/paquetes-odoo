// Types only: lib/busqueda/paquetes.ts reaches the database and Odoo.
import type { LugarDelPaquete } from '@/lib/busqueda/paquetes'
import { fechaYHora } from '@/lib/fechas'

/*
 * What the search of a package says of each place it found it in, and where it can take the operario from there. Every
 * place is shown, whatever its almacén: what the operario may not open has no way in.
 */

/** What the operario may open from the search. */
export interface AccesoDelOperario {
  /** The almacenes the operario has: their recepciones are the ones that can be opened (the page of one asks it). */
  almacenIds: readonly number[]
  /** The almacén Entrega works in: the deliveries waiting in it are the only ones that can be opened from here. */
  almacenActivoId: number | null
  /** Whether Pendientes shows the operario the problems of every almacén (the admin), or only those of theirs. */
  todosLosPendientes: boolean
}

export interface Enlace {
  href: string
  texto: string
}

/** How a place is going, in the colors of the app: green for what is done, amber for what is on its way, red for a problem. */
export interface EstadoDeLugar {
  texto: string
  tono: 'ok' | 'en_curso' | 'problema'
}

export interface DescripcionDeLugar {
  /** What happened to the package there: "Recibido", "Esperando entrega"… */
  titulo: string
  estado: EstadoDeLugar
  /** Where, when and who: "MB92 · MAYANQUEEN · 28/10 10:32 · Veronika". */
  detalle: string
}

/** How a send of the webapp is going, with the picking it is in Odoo under once it is there. */
function estadoDeEnvio(estado: 'enviando' | 'ok' | 'problema', ref: string | null): EstadoDeLugar {
  if (estado === 'enviando') return { texto: 'enviándose a Odoo…', tono: 'en_curso' }
  if (estado === 'ok') return { texto: `✓ ${ref ?? 'en Odoo'}`, tono: 'ok' }
  return { texto: '⚠ no se pudo enviar a Odoo', tono: 'problema' }
}

/** The almacén, the barco, the day and who, those that the place has. */
function detalleDe(lugar: LugarDelPaquete, entrada: { ahora: Date; quien: string | null }): string {
  return [lugar.almacenPrefijo, lugar.barcoNombre, fechaYHora(lugar.fecha, entrada.ahora), entrada.quien].filter(Boolean).join(' · ')
}

/** What the search says of a place: what happened there, how it is going, and where, when and who. */
export function describirLugar(lugar: LugarDelPaquete, ahora: Date): DescripcionDeLugar {
  if (lugar.tipo === 'recepcion') {
    const detalle = detalleDe(lugar, { ahora, quien: lugar.operarioNombre })
    if (lugar.duplicado) {
      return { titulo: 'Escaneado como duplicado', estado: { texto: `ya estaba en ${lugar.duplicadoRef ?? 'Odoo'} · no se envió`, tono: 'problema' }, detalle }
    }
    if (lugar.estado === 'abierta') return { titulo: 'En una recepción abierta', estado: { texto: 'sin enviar a Odoo', tono: 'en_curso' }, detalle }
    return { titulo: 'Recibido', estado: estadoDeEnvio(lugar.estado, lugar.odooPickingRef), detalle }
  }

  if (lugar.tipo === 'entrega') {
    const quien = lugar.receptorNombre ? `recibió ${lugar.receptorNombre}` : null
    return { titulo: 'Entregado', estado: estadoDeEnvio(lugar.estado, lugar.pickingRef), detalle: detalleDe(lugar, { ahora, quien }) }
  }

  if (lugar.tipo === 'reasignacion') {
    // From which barco to which: the detail names both where the others name one.
    const conLosDosBarcos = { ...lugar, barcoNombre: `${lugar.barcoNombre} → ${lugar.barcoDestinoNombre}` }
    return {
      titulo: 'Cambiado de barco',
      estado: estadoDeEnvio(lugar.estado, lugar.destinoRef),
      detalle: detalleDe(conLosDosBarcos, { ahora, quien: lugar.operarioNombre }),
    }
  }

  const enCurso: EstadoDeLugar = { texto: lugar.pickingRef, tono: 'en_curso' }
  const hecho: EstadoDeLugar = { texto: `✓ ${lugar.pickingRef}`, tono: 'ok' }
  if (lugar.operacion === 'recepcion') {
    const detalle = detalleDe(lugar, { ahora, quien: lugar.recibidoPor })
    return lugar.hecho
      ? { titulo: 'Recibido en Odoo', estado: hecho, detalle }
      : { titulo: 'Recepción sin validar en Odoo', estado: enCurso, detalle }
  }
  if (lugar.operacion === 'entrega') {
    return lugar.hecho
      ? { titulo: 'Entregado', estado: hecho, detalle: detalleDe(lugar, { ahora, quien: lugar.recibidoPor ? `recibió ${lugar.recibidoPor}` : null }) }
      : { titulo: 'Esperando entrega', estado: enCurso, detalle: detalleDe(lugar, { ahora, quien: null }) }
  }
  return { titulo: 'En Odoo', estado: lugar.hecho ? hecho : enCurso, detalle: detalleDe(lugar, { ahora, quien: null }) }
}

/**
 * Where the operario can go from a place, with the package as the filter of the list it opens; null when nowhere:
 *
 * - a recepción opens (the screen to scan, or what it had once it was sent) when the operario has its almacén, which is
 *   what its page asks of everybody, the admin included. One that could not be sent goes to Pendientes instead, if
 *   Pendientes shows the operario that almacén: that is where it is retried;
 * - an entrega has no screen of its own: only one that could not be sent goes somewhere, to Pendientes. So it is with a
 *   reasignación: where its package waits now is the delivery of Odoo it went into, which is a place of its own;
 * - a delivery of Odoo still waiting opens its barco in Entrega, but only in the almacén Entrega works in: in any other
 *   the barco would open with what it has waiting in this one;
 * - anything else in Odoo is only told.
 */
export function enlaceDeLugar(lugar: LugarDelPaquete, acceso: AccesoDelOperario): Enlace | null {
  const conFiltro = (ruta: string) => `${ruta}?q=${encodeURIComponent(lugar.trackingNumber)}`
  const suyo = lugar.almacenId !== null && acceso.almacenIds.includes(lugar.almacenId)
  const aPendientes = acceso.todosLosPendientes || suyo ? { href: conFiltro('/pendientes'), texto: 'Ver en Pendientes' } : null

  if (lugar.tipo === 'recepcion') {
    if (lugar.estado === 'problema' && !lugar.duplicado) return aPendientes
    return suyo ? { href: conFiltro(`/recepcion/${lugar.sesionId}`), texto: 'Abrir' } : null
  }
  if (lugar.tipo === 'entrega' || lugar.tipo === 'reasignacion') return lugar.estado === 'problema' ? aPendientes : null

  const esperaEnEsteAlmacen = lugar.operacion === 'entrega' && !lugar.hecho && lugar.almacenId !== null && lugar.almacenId === acceso.almacenActivoId
  return esperaEnEsteAlmacen && lugar.barcoOdooId !== null ? { href: conFiltro(`/entrega/${lugar.barcoOdooId}`), texto: 'Abrir' } : null
}
