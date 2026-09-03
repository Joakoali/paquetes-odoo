import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { operarios, type Operario } from '../../db/schema'
import { hashPassword } from '../auth/password'

export async function listOperarios(): Promise<Operario[]> {
  return db.query.operarios.findMany()
}

export async function createOperario(input: {
  nombre: string
  login: string
  password: string
  rol: 'operario' | 'admin'
}): Promise<Operario> {
  const passwordHash = await hashPassword(input.password)
  const [row] = await db.insert(operarios).values({
    nombre: input.nombre,
    login: input.login,
    passwordHash,
    rol: input.rol,
  }).returning()
  return row
}

export async function setOperarioActivo(id: string, activo: boolean): Promise<void> {
  await db.update(operarios).set({ activo }).where(eq(operarios.id, id))
}
