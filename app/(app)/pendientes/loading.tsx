import { Cargando } from '@/components/cargando'

/** While the problems of the almacenes of the operario are read. */
export default function CargandoPendientes() {
  return (
    <Cargando texto="Buscando lo que quedó pendiente…">
      <h1>Pendientes</h1>
    </Cargando>
  )
}
