import { describe, expect, it } from 'vitest'
import { ConfiguracionError, ErrorParaOperario, OdooError } from '@/lib/errores'
import { LECTURA_DE_ODOO_FALLIDA, mensajeDeLecturaFallida } from './lectura-fallida'

describe('mensajeDeLecturaFallida', () => {
  it('is the message of an error that is written for the operario, as it is', () => {
    const error = new ConfiguracionError('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')

    expect(mensajeDeLecturaFallida(error)).toBe('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')
    expect(mensajeDeLecturaFallida(new ErrorParaOperario('Algo para leer'))).toBe('Algo para leer')
  })

  it('says that Odoo could not be read when Odoo answered with an error', () => {
    expect(mensajeDeLecturaFallida(new OdooError({ status: 500, data: 'Bad gateway' }))).toBe(LECTURA_DE_ODOO_FALLIDA)
    expect(mensajeDeLecturaFallida(new OdooError({ status: 403, data: { name: 'odoo.exceptions.AccessError', message: 'no' } })))
      .toBe(LECTURA_DE_ODOO_FALLIDA)
  })

  it('says it when Odoo did not answer at all: a timeout, or no connection', () => {
    const tiempo = new Error('The operation was aborted due to timeout')
    tiempo.name = 'TimeoutError'

    expect(mensajeDeLecturaFallida(tiempo)).toBe(LECTURA_DE_ODOO_FALLIDA)
    expect(mensajeDeLecturaFallida(new TypeError('fetch failed'))).toBe(LECTURA_DE_ODOO_FALLIDA)
  })

  it('is null for anything else, which is a bug and not a reading to retry: the page lets it through to the error screen', () => {
    expect(mensajeDeLecturaFallida(new Error('Cannot read properties of undefined'))).toBeNull()
    expect(mensajeDeLecturaFallida(new TypeError('x is not a function'))).toBeNull()
    expect(mensajeDeLecturaFallida('boom')).toBeNull()
  })
})
