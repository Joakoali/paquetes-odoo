import Link from 'next/link'
import type { Operario } from '@/db/schema'
import { getAlmacenActivo } from '@/lib/almacen-activo'
import { buscarPaquetes, type LugarDelPaquete, type PaqueteEncontrado } from '@/lib/busqueda/paquetes'
import { alcanceDelOperario } from '@/lib/sync/pendientes'
import { textoDePaquetes } from '@/lib/ui/cola-escaneo'
import { describirLugar, enlaceDeLugar, type AccesoDelOperario } from '@/lib/ui/lugar-del-paquete'

/** A place of a package: what happened there and how it is going, where, when and who, and the way in if there is one. */
function FilaDeLugar({ lugar, acceso, ahora }: { lugar: LugarDelPaquete; acceso: AccesoDelOperario; ahora: Date }) {
  const { titulo, estado, detalle } = describirLugar(lugar, ahora)
  const enlace = enlaceDeLugar(lugar, acceso)

  return (
    <li className="busqueda-lugar">
      <span className="fila-texto">
        <span className="busqueda-lugar-titulo">
          {titulo} · <span className={`busqueda-lugar-estado busqueda-lugar-${estado.tono}`}>{estado.texto}</span>
        </span>
        <span className="fila-meta">{detalle}</span>
      </span>
      {/* Not prefetched: opening a barco of Entrega is a live reading of Odoo, and nobody may open any of these. */}
      {enlace ? <Link href={enlace.href} prefetch={false} className="btn-link busqueda-lugar-enlace">{enlace.texto} ›</Link> : null}
    </li>
  )
}

/** A package that was found: its number and courier, and every place it has been in, the last one being where it is. */
function TarjetaDePaquete({ paquete, acceso, ahora }: { paquete: PaqueteEncontrado; acceso: AccesoDelOperario; ahora: Date }) {
  return (
    <li className="card busqueda-paquete">
      <p className="busqueda-paquete-cabecera">
        <span className="mono busqueda-paquete-codigo">{paquete.trackingNumber}</span>
        {paquete.courierNombre ? <span className="badge">{paquete.courierNombre}</span> : null}
      </p>
      <ol className="busqueda-lugares">
        {paquete.lugares.map((lugar, posicion) => <FilaDeLugar key={posicion} lugar={lugar} acceso={acceso} ahora={ahora} />)}
      </ol>
    </li>
  )
}

/**
 * Where the packages whose number contains what was searched are, in every almacén. What the operario can open of them is
 * decided by the almacenes they have and the one they work in (`enlaceDeLugar`). `escrito` is what was typed, as it is
 * said back; `buscado`, what is looked for. When Odoo could not be read, what is shown is what the webapp has, and it says
 * so above it.
 */
export async function Resultados({ buscado, escrito, operario }: {
  buscado: string
  escrito: string
  operario: Pick<Operario, 'id' | 'rol'>
}) {
  const [busqueda, almacenes, alcance] = await Promise.all([
    buscarPaquetes(buscado),
    getAlmacenActivo(operario.id),
    alcanceDelOperario(operario),
  ])
  const acceso: AccesoDelOperario = {
    almacenIds: almacenes.disponibles.map((almacen) => almacen.id),
    almacenActivoId: almacenes.activo?.id ?? null,
    todosLosPendientes: alcance === 'todos',
  }
  const ahora = new Date()
  const { paquetes, hayMas, odooFallo } = busqueda

  return (
    <>
      {odooFallo ? <p className="banner banner-warn" role="alert">{odooFallo} Abajo está solo lo que tiene la webapp.</p> : null}

      {paquetes.length === 0 ? (
        <p className="lista-vacia" role="status">
          Ningún paquete tiene «{escrito}» en el tracking{odooFallo ? ' en la webapp.' : ', ni en la webapp ni en Odoo.'}
        </p>
      ) : (
        <section className="inicio-seccion" aria-labelledby="resultados-rotulo">
          <h2 className="label" id="resultados-rotulo">{textoDePaquetes(paquetes.length)} con «{escrito}»</h2>
          <ul className="busqueda-resultados">
            {paquetes.map((paquete) => (
              <TarjetaDePaquete key={paquete.trackingNumber} paquete={paquete} acceso={acceso} ahora={ahora} />
            ))}
          </ul>
          {hayMas ? <p className="busqueda-estado">Hay más resultados: escribí más del número.</p> : null}
        </section>
      )}
    </>
  )
}
