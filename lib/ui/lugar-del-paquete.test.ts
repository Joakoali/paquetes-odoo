import { describe, expect, it } from 'vitest'
import type { LugarEntrega, LugarOdoo, LugarRecepcion } from '@/lib/busqueda/paquetes'
import { describirLugar, enlaceDeLugar, type AccesoDelOperario } from './lugar-del-paquete'

const AHORA = new Date('2026-10-29T12:00:00Z')
/** 28/10 10:32 in Madrid. */
const FECHA = new Date('2026-10-28T09:32:00Z')

const base = {
  trackingNumber: 'JJD 0588', almacenId: 1, almacenPrefijo: 'MB92', barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', fecha: FECHA,
}

const recepcion = (datos: Partial<LugarRecepcion> = {}): LugarRecepcion => ({
  ...base, tipo: 'recepcion', sesionId: 's1', estado: 'ok', odooPickingRef: 'MB92/IN/00231', operarioNombre: 'Veronika',
  duplicado: false, duplicadoRef: null, ...datos,
})

const entrega = (datos: Partial<LugarEntrega> = {}): LugarEntrega => ({
  ...base, tipo: 'entrega', sesionId: 'e1', estado: 'enviando', pickingRef: 'MB92/OUT/00487', receptorNombre: 'Tom Baker', ...datos,
})

const odoo = (datos: Partial<LugarOdoo> = {}): LugarOdoo => ({
  ...base, tipo: 'odoo', operacion: 'entrega', hecho: false, pickingRef: 'MB92/OUT/00487', recibidoPor: null, ...datos,
})

/** An operario of MB92 (almacén 1), working in it, who sees the problems of their almacenes only. */
const operario: AccesoDelOperario = { almacenIds: [1], almacenActivoId: 1, todosLosPendientes: false }

describe('describirLugar', () => {
  describe('a recepción of the webapp', () => {
    it('says it was received, where, when and who scanned it, and the picking it is in Odoo under', () => {
      expect(describirLugar(recepcion(), AHORA)).toEqual({
        titulo: 'Recibido',
        estado: { texto: '✓ MB92/IN/00231', tono: 'ok' },
        detalle: 'MB92 · MAYANQUEEN · 28/10 10:32 · Veronika',
      })
    })

    it('says an open one has not been sent', () => {
      expect(describirLugar(recepcion({ estado: 'abierta', odooPickingRef: null }), AHORA)).toMatchObject({
        titulo: 'En una recepción abierta', estado: { texto: 'sin enviar a Odoo', tono: 'en_curso' },
      })
    })

    it('says how the sending of one that was sent is going', () => {
      expect(describirLugar(recepcion({ estado: 'enviando' }), AHORA).estado).toEqual({ texto: 'enviándose a Odoo…', tono: 'en_curso' })
      expect(describirLugar(recepcion({ estado: 'problema' }), AHORA).estado).toEqual({ texto: '⚠ no se pudo enviar a Odoo', tono: 'problema' })
    })

    it('says a duplicado was not sent, and where Odoo had it, not the picking the recepción made', () => {
      expect(describirLugar(recepcion({ duplicado: true, duplicadoRef: 'MB92/IN/00198' }), AHORA)).toMatchObject({
        titulo: 'Escaneado como duplicado', estado: { texto: 'ya estaba en MB92/IN/00198 · no se envió', tono: 'problema' },
      })
    })
  })

  describe('an entrega of the webapp', () => {
    it('says it was delivered, to whom, and how its sending is going', () => {
      expect(describirLugar(entrega(), AHORA)).toEqual({
        titulo: 'Entregado',
        estado: { texto: 'enviándose a Odoo…', tono: 'en_curso' },
        detalle: 'MB92 · MAYANQUEEN · 28/10 10:32 · recibió Tom Baker',
      })
      expect(describirLugar(entrega({ estado: 'ok' }), AHORA).estado).toEqual({ texto: '✓ MB92/OUT/00487', tono: 'ok' })
    })

    it('leaves out who received when nobody is named', () => {
      expect(describirLugar(entrega({ receptorNombre: null }), AHORA).detalle).toBe('MB92 · MAYANQUEEN · 28/10 10:32')
    })
  })

  describe('a picking of Odoo', () => {
    it('says a delivery is waiting, or that it was delivered and to whom', () => {
      expect(describirLugar(odoo(), AHORA)).toEqual({
        titulo: 'Esperando entrega', estado: { texto: 'MB92/OUT/00487', tono: 'en_curso' }, detalle: 'MB92 · MAYANQUEEN · 28/10 10:32',
      })
      expect(describirLugar(odoo({ hecho: true, recibidoPor: 'Capitán Pérez' }), AHORA)).toEqual({
        titulo: 'Entregado', estado: { texto: '✓ MB92/OUT/00487', tono: 'ok' }, detalle: 'MB92 · MAYANQUEEN · 28/10 10:32 · recibió Capitán Pérez',
      })
    })

    it('says a reception was received, by whom, or that it is not validated yet', () => {
      expect(describirLugar(odoo({ operacion: 'recepcion', hecho: true, pickingRef: 'MB92/IN/00231', recibidoPor: 'Veronika' }), AHORA)).toEqual({
        titulo: 'Recibido en Odoo', estado: { texto: '✓ MB92/IN/00231', tono: 'ok' }, detalle: 'MB92 · MAYANQUEEN · 28/10 10:32 · Veronika',
      })
      expect(describirLugar(odoo({ operacion: 'recepcion', pickingRef: 'MB92/IN/00231' }), AHORA)).toMatchObject({
        titulo: 'Recepción sin validar en Odoo', estado: { texto: 'MB92/IN/00231', tono: 'en_curso' },
      })
    })

    it('only names a picking that is neither, and leaves out what it does not know of it', () => {
      expect(describirLugar(odoo({ operacion: 'otra', hecho: true, pickingRef: 'MB92/INT/00004', almacenPrefijo: null, barcoNombre: null }), AHORA)).toEqual({
        titulo: 'En Odoo', estado: { texto: '✓ MB92/INT/00004', tono: 'ok' }, detalle: '28/10 10:32',
      })
    })
  })
})

describe('enlaceDeLugar', () => {
  it('opens a recepción of an almacén of the operario, filtered by the package', () => {
    expect(enlaceDeLugar(recepcion(), operario)).toEqual({ href: '/recepcion/s1?q=JJD%200588', texto: 'Abrir' })
    expect(enlaceDeLugar(recepcion({ estado: 'abierta' }), operario)?.href).toBe('/recepcion/s1?q=JJD%200588')
  })

  it('does not open a recepción of an almacén the operario does not have, nor of one the app does not know', () => {
    expect(enlaceDeLugar(recepcion({ almacenId: 7 }), operario)).toBeNull()
    expect(enlaceDeLugar(recepcion({ almacenId: null }), operario)).toBeNull()
    // The admin too: the page of a recepción asks everybody for its almacén.
    expect(enlaceDeLugar(recepcion({ almacenId: 7 }), { ...operario, todosLosPendientes: true })).toBeNull()
  })

  it('takes a recepción or an entrega that could not be sent to Pendientes, if Pendientes shows the operario its almacén', () => {
    const aPendientes = { href: '/pendientes?q=JJD%200588', texto: 'Ver en Pendientes' }

    expect(enlaceDeLugar(recepcion({ estado: 'problema' }), operario)).toEqual(aPendientes)
    expect(enlaceDeLugar(entrega({ estado: 'problema' }), operario)).toEqual(aPendientes)
    expect(enlaceDeLugar(entrega({ estado: 'problema', almacenId: 7 }), operario)).toBeNull()
    // The admin sees the problems of every almacén.
    expect(enlaceDeLugar(entrega({ estado: 'problema', almacenId: 7 }), { ...operario, todosLosPendientes: true })).toEqual(aPendientes)
  })

  it('opens the recepción of a duplicado, which is not a problem to retry, whatever became of the rest', () => {
    expect(enlaceDeLugar(recepcion({ estado: 'problema', duplicado: true }), operario)?.href).toBe('/recepcion/s1?q=JJD%200588')
  })

  it('takes an entrega that is on its way or in Odoo nowhere: it has no screen', () => {
    expect(enlaceDeLugar(entrega(), operario)).toBeNull()
    expect(enlaceDeLugar(entrega({ estado: 'ok' }), operario)).toBeNull()
  })

  it('opens the barco of a delivery waiting in the almacén Entrega works in, filtered by the package', () => {
    expect(enlaceDeLugar(odoo(), operario)).toEqual({ href: '/entrega/673?q=JJD%200588', texto: 'Abrir' })
  })

  it('does not open a delivery waiting in another almacén, even one of the operario: the barco would open with this one', () => {
    expect(enlaceDeLugar(odoo({ almacenId: 7 }), { ...operario, almacenIds: [1, 7] })).toBeNull()
    expect(enlaceDeLugar(odoo(), { ...operario, almacenActivoId: null })).toBeNull()
  })

  it('opens nothing for a delivery done, one without barco yet, or a reception of Odoo', () => {
    expect(enlaceDeLugar(odoo({ hecho: true }), operario)).toBeNull()
    expect(enlaceDeLugar(odoo({ barcoOdooId: null }), operario)).toBeNull()
    expect(enlaceDeLugar(odoo({ operacion: 'recepcion' }), operario)).toBeNull()
  })
})
