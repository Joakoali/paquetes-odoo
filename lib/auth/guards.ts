import { getSessionOperario } from './session'
import type { Operario } from '../../db/schema'

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

export async function requireOperario(token: string | undefined): Promise<Operario> {
  if (!token) throw new UnauthorizedError('No session token')
  const operario = await getSessionOperario(token)
  if (!operario) throw new UnauthorizedError('Invalid or expired session')
  return operario
}

export async function requireAdmin(token: string | undefined): Promise<Operario> {
  const operario = await requireOperario(token)
  if (operario.rol !== 'admin') throw new ForbiddenError('Admin role required')
  return operario
}
