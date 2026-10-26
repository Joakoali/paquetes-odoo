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

/** What Postgres accepts as a uuid. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Activates or deactivates an operario: `activo` is what it is to be after this. The admin cannot lock everybody out,
 * so deactivating yourself is refused here (the domain does not know who is asking) and so is deactivating the last
 * active admin (the domain knows). The values come from the client like everything else: an id that is not a uuid
 * names nobody, and a state that is not true or false is not one to be written to the database.
 */
export async function toggleOperarioActivoAction(id: string, activo: boolean): Promise<ResultadoAccion> {
  return ejecutarAccion(async () => {
    const admin = await requireAdminFromCookies()
    if (typeof id !== 'string' || !UUID.test(id)) throw new ErrorParaOperario('Ese operario no existe.')
    if (typeof activo !== 'boolean') throw new ErrorParaOperario('Ese cambio no es válido.')
    if (!activo && id.toLowerCase() === admin.id) throw new ErrorParaOperario('No podés desactivar tu propio usuario.')

    await setOperarioActivo(id, activo)
    await registrarAuditoria({
      operarioId: admin.id,
      accion: 'admin_operario_activo',
      detalle: { operarioId: id, activo },
    })
    revalidatePath('/admin/operarios')
  })
}
