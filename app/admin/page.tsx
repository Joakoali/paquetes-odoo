import { requireAdminFromCookies } from '@/lib/auth/current-operario'
import { haceCuanto } from '@/lib/fechas'
import { contarMaestrosActivos, ultimoRefresco } from '@/lib/maestros/refresh'
import { RefrescarDatos } from './RefrescarDatos'

/** A line of the summary: what it is, and on the right what there is. */
function Fila({ nombre, valor }: { nombre: string; valor: string | number }) {
  return (
    <li className="list-row">
      <span className="fila-texto"><span className="fila-nombre">{nombre}</span></span>
      <span className="fila-cuenta">{valor}</span>
    </li>
  )
}

export default async function DatosDeOdooPage() {
  await requireAdminFromCookies()
  const ahora = new Date()
  const [ultimo, activos] = await Promise.all([ultimoRefresco(), contarMaestrosActivos()])

  return (
    <main className="page">
      <h1>Datos de Odoo</h1>
      <p>
        Los barcos, los almacenes y los couriers se leen de Odoo, y se refrescan solos todos los días a primera hora.
        Si algo cambió en Odoo y lo necesitás ya, refrescalo acá.
      </p>

      <ul className="list">
        <Fila nombre="Último refresco" valor={ultimo ? haceCuanto(ultimo, ahora) : 'Nunca'} />
        <Fila nombre="Almacenes activos" valor={activos.almacenes} />
        <Fila nombre="Couriers activos" valor={activos.couriers} />
      </ul>

      <RefrescarDatos />
    </main>
  )
}
