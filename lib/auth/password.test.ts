import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('password', () => {
  it('hashes and verifies correctly', async () => {
    const hash = await hashPassword('correct-horse')
    expect(hash).not.toBe('correct-horse')
    expect(await verifyPassword('correct-horse', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })
})
