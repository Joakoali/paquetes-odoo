import { describe, it, expect, vi } from 'vitest'

vi.mock('./session', () => ({
  getSessionOperario: vi.fn(),
}))

import { getSessionOperario } from './session'
import { requireOperario, requireAdmin, UnauthorizedError, ForbiddenError } from './guards'

describe('guards', () => {
  it('requireOperario throws UnauthorizedError with no token', async () => {
    await expect(requireOperario(undefined)).rejects.toThrow(UnauthorizedError)
  })

  it('requireOperario returns the operario when session is valid', async () => {
    vi.mocked(getSessionOperario).mockResolvedValue({ id: 'op-1', rol: 'operario' } as any)
    const operario = await requireOperario('token-1')
    expect(operario.id).toBe('op-1')
  })

  it('requireAdmin throws ForbiddenError for a non-admin operario', async () => {
    vi.mocked(getSessionOperario).mockResolvedValue({ id: 'op-1', rol: 'operario' } as any)
    await expect(requireAdmin('token-1')).rejects.toThrow(ForbiddenError)
  })
})
