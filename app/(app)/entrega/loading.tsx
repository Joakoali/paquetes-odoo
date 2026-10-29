import { Cargando } from '@/components/cargando'

/** While the barcos with packages waiting are read from Odoo, which takes as long as Odoo takes to answer. */
export default function CargandoEntrega() {
  return <Cargando texto="Buscando en Odoo los barcos con paquetes para entregar…" />
}
