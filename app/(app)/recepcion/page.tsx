import { redirect } from 'next/navigation'
import type { Almacen } from '@/db/schema'
import { requireAlmacenActivo } from '@/lib/almacen-activo'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { ErrorParaOperario } from '@/lib/errores'
import { getCouriersParaRecepcion } from '@/lib/recepcion/couriers'
import { listarEnviadasHoy, listarRecepcionesAbiertas } from '@/lib/recepcion/recepciones'
import { RecepcionHome } from './RecepcionHome'

/** The home of Recepción: what is open and what was sent today in the almacén the operario is working in. */
export default async function RecepcionPage() {
  // The layout sends whoever has no valid session to the login, but it does not render again when the operario
  // moves from one tab to another: this is the check that does when the session expired meanwhile.
  const operario = await requireOperarioFromCookies().catch(() => redirect('/login'))

  let almacen: Almacen
  try {
    almacen = await requireAlmacenActivo(operario.id)
  } catch (error) {
    // An operario with no almacén gets told so. Any other failure is not for them to read: it goes to the error page.
    if (error instanceof ErrorParaOperario) {
      return (
        <main className="page">
          <p className="banner banner-warn">{error.message}</p>
        </main>
      )
    }
    throw error
  }

  const [abiertas, enviadas, couriers] = await Promise.all([
    listarRecepcionesAbiertas(almacen.id),
    listarEnviadasHoy(almacen.id),
    getCouriersParaRecepcion(almacen.id),
  ])

  // `ahora` is read here and handed down: the home is also drawn in the browser, and each clock would say a different time.
  return (
    <main className="page">
      <RecepcionHome abiertas={abiertas} enviadas={enviadas} couriers={couriers} ahora={new Date()} />
    </main>
  )
}
