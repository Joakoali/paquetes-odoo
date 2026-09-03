import { db } from './client'
import { operarios } from './schema'
import { hashPassword } from '../lib/auth/password'

// Crea (o deja como está) un operario admin de desarrollo.
// Uso: npm run db:seed:operario -- <login> <password> [nombre]
async function main() {
  const [login = 'admin', password = 'admin1234', nombre = 'Admin Dev'] = process.argv.slice(2)
  const passwordHash = await hashPassword(password)
  await db
    .insert(operarios)
    .values({ nombre, login, passwordHash, rol: 'admin' })
    .onConflictDoNothing()
  console.log(`Operario dev listo: login="${login}" password="${password}" rol=admin`)
}

main()
