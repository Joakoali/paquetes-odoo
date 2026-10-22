import { describe, it, expect } from 'vitest'
import * as schema from './schema'

describe('schema', () => {
  it('exports all fase 1 tables', () => {
    const expected = [
      'operarios', 'sesionesAuth', 'almacenes', 'operarioAlmacenes',
      'barcosCache', 'couriers', 'sesionesEscaneo', 'sesionCourierBatches',
      'sesionItems', 'trackingActivosCache', 'auditLog',
      'courierUso', 'errorTipoEnum',
    ]
    for (const name of expected) {
      expect(schema).toHaveProperty(name)
    }
  })
})
