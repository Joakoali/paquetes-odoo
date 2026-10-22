import { describe, it, expect } from 'vitest'
import type { ErrorTipo } from '../db/schema'
import { OdooError } from './odoo/client'
import {
  ConfiguracionError,
  ErrorParaOperario,
  RespuestaOdooInesperadaError,
  clasificarError,
  mensajeProblema,
} from './errores'

describe('clasificarError', () => {
  const cases: Array<{ label: string; err: unknown; tipo: ErrorTipo }> = [
    { label: 'ConfiguracionError', err: new ConfiguracionError('x'), tipo: 'configuracion' },

    // Odoo, or whatever sits in front of it, is overloaded or unreachable: worth retrying.
    { label: 'OdooError 503', err: new OdooError({ status: 503, data: null }), tipo: 'conexion' },
    { label: 'OdooError 429', err: new OdooError({ status: 429, data: null }), tipo: 'conexion' },
    { label: 'OdooError 502', err: new OdooError({ status: 502, data: null }), tipo: 'conexion' },
    { label: 'OdooError 504', err: new OdooError({ status: 504, data: null }), tipo: 'conexion' },
    { label: 'OdooError 500 with an HTML page', err: new OdooError({ status: 500, data: 'bad gateway html' }), tipo: 'conexion' },
    { label: 'OdooError 500 with an empty body', err: new OdooError({ status: 500, data: null }), tipo: 'conexion' },
    { label: 'TypeError fetch failed', err: new TypeError('fetch failed'), tipo: 'conexion' },
    { label: 'error named TimeoutError', err: Object.assign(new Error('t'), { name: 'TimeoutError' }), tipo: 'conexion' },
    { label: 'error named AbortError', err: Object.assign(new Error('a'), { name: 'AbortError' }), tipo: 'conexion' },
    {
      // What fetch rejects with when AbortSignal.timeout() fires.
      label: 'DOMException TimeoutError',
      err: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      tipo: 'conexion',
    },

    // Odoo answered and said no: sending the same thing again gets the same answer.
    {
      label: 'OdooError 422 ValidationError',
      err: new OdooError({ status: 422, data: { name: 'odoo.exceptions.ValidationError', message: 'x' } }),
      tipo: 'odoo',
    },
    {
      label: 'OdooError 500 UserError',
      err: new OdooError({ status: 500, data: { name: 'odoo.exceptions.UserError', message: 'x' } }),
      tipo: 'odoo',
    },
    { label: 'OdooError 404 with no Odoo exception', err: new OdooError({ status: 404, data: 'Not Found' }), tipo: 'odoo' },
    { label: 'TypeError that is not a fetch failure', err: new TypeError('x is not a function'), tipo: 'odoo' },
    { label: 'RespuestaOdooInesperadaError', err: new RespuestaOdooInesperadaError('x'), tipo: 'odoo' },
    { label: 'plain Error', err: new Error('picking 5 no existe en Odoo'), tipo: 'odoo' },
    { label: 'thrown string', err: 'boom', tipo: 'odoo' },
    { label: 'thrown null', err: null, tipo: 'odoo' },
  ]

  it.each(cases)('$label → $tipo', ({ err, tipo }) => {
    expect(clasificarError(err)).toBe(tipo)
  })
})

describe('mensajeProblema', () => {
  const copy: Array<[ErrorTipo, string]> = [
    ['configuracion', 'No se pudo enviar a Odoo: falta configuración. Lo tiene que arreglar el admin.'],
    ['conexion', 'Odoo no respondió. Se reintentó solo y no hubo caso. Probá Reintentar en un rato.'],
    ['odoo', 'Odoo rechazó el envío. Mirá el detalle o avisá al admin.'],
  ]

  it.each(copy)('%s → the copy the operator reads', (tipo, text) => {
    expect(mensajeProblema(tipo)).toBe(text)
  })
})

describe('error classes', () => {
  it('a ConfiguracionError can be shown to the operator but an unexpected Odoo answer cannot', () => {
    expect(new ConfiguracionError('x')).toBeInstanceOf(ErrorParaOperario)
    expect(new RespuestaOdooInesperadaError('x')).not.toBeInstanceOf(ErrorParaOperario)
  })
})
