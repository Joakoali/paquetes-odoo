'use server'

import { revalidatePath } from 'next/cache'
import { ejecutarAccion, type ResultadoAccion } from '@/lib/acciones'
import { createOperario, setOperarioActivo } from '@/lib/admin/operarios'
import { registrarAuditoria } from '@/lib/audit'
import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { ErrorParaOperario } from '@/lib/errores'

/** The length of the `login` column. */
const LARGO_MAXIMO_USUARIO = 64

/** What the client sent, as text with the spaces around it taken off; anything else is nothing. */
const texto = (valor: unknown): string => (typeof valor === 'string' ? valor.trim() : '')

/**
 * Creates an operario. The values come from the client like everything else, so they are checked here: what is
 * wrong is told to the admin in words. The audit line says who the new operario is and never the password.
 */
export async function createOperarioAction(entrada: {
  nombre: string
  login: string
  password: string
  rol: string
}): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    const admin = await requireAdminFromCookies()

    const nombre = texto(entrada.nombre)
    const login = texto(entrada.login)
    // Not trimmed: the spaces of a password are part of it.
    const password = typeof entrada.password === 'string' ? entrada.password : ''
    if (nombre === '') throw new ErrorParaOperario('Falta el nombre.')
    if (login === '') throw new ErrorParaOperario('Falta el usuario.')
    if (login.length > LARGO_MAXIMO_USUARIO) {
      throw new ErrorParaOperario(`El usuario puede tener hasta ${LARGO_MAXIMO_USUARIO} caracteres.`)
    }
    if (password === '') throw new ErrorParaOperario('Falta la contraseña.')

    const rol = entrada.rol === 'admin' ? 'admin' : 'operario'
    const operario = await createOperario({ nombre, login, password, rol })
    await registrarAuditoria({
      operarioId: admin.id,
      accion: 'admin_operario_creado',
      detalle: { operarioId: operario.id, login: operario.login, rol: operario.rol },
    })
    revalidatePath('/admin/operarios')
  })
}

/** Activates or deactivates an operario: `activo` is what it is to be after this. */
export async function toggleOperarioActivoAction(id: string, activo: boolean): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    const admin = await requireAdminFromCookies()
    await setOperarioActivo(id, activo)
    await registrarAuditoria({
      operarioId: admin.id,
      accion: 'admin_operario_activo',
      detalle: { operarioId: id, activo },
    })
    revalidatePath('/admin/operarios')
  })
}
