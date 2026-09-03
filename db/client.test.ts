import { describe, it, expect } from 'vitest'
import { db } from './client'

describe('db client', () => {
  it('exports a drizzle db instance with a select method', () => {
    expect(typeof db.select).toBe('function')
  })
})
