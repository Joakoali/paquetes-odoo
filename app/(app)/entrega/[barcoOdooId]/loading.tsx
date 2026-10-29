import Link from 'next/link'
import { Cargando } from '@/components/cargando'

/** While the packages of the barco are read from Odoo. The way back to the list is already there. */
export default function CargandoBarco() {
  return (
    <Cargando texto="Leyendo en Odoo los paquetes del barco…">
      <header className="barco-cabecera">
        <Link href="/entrega" className="btn-link">‹ Entrega</Link>
      </header>
    </Cargando>
  )
}
