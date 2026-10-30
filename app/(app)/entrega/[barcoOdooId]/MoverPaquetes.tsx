'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { BarcoSearch } from '@/components/barco-search'
import { FiltroTracking } from '@/components/filtro-tracking'
// Types only: these modules reach the database and Odoo, which must not get into the client.
import type { BarcoOpcion } from '@/lib/cache/barcos'
import type { LineaEntrega } from '@/lib/odoo/pickings'
import { filtrarPorTracking, mostrarFiltro } from '@/lib/ui/busqueda-tracking'
import { textoDePaquetes } from '@/lib/ui/cola-escaneo'
import { textoDeConfirmacion, textoDeElegirBarco, textoDeSeleccionAMover } from '@/lib/ui/mover-paquetes'
import { alternarLinea, resumenSeleccion, textoDeLinea } from '@/lib/ui/seleccion-entrega'
import { llamarAccion } from '@/lib/ui/textoDeFallo'
import { moverPaquetesAction } from '../actions'
import { FilaDeLinea } from './FilaDeLinea'

type Paso = 'paquetes' | 'barco' | 'confirmar'

/**
 * Moving packages of the barco to another one, when they were received for the wrong barco, in three steps:
 *
 * - `paquetes`: the lines Odoo has waiting for the barco, none of them chosen; touching one chooses it.
 * - `barco`: the search of barcos, for the one they are for. The barco they are on is not offered.
 * - `confirmar`: what goes, from where to where, and the button that confirms.
 *
 * Confirming must make nothing twice, as an entrega: the `id` is made up once, before the first try, and every try sends
 * it. After a failure nothing can change but "Reintentar", which sends the same again, or "Cancelar". When it is
 * registered, the answer of the server draws the barco again without the packages, which are on their way: this screen
 * goes away with them, and the strip of the barco says where they go.
 *
 * The filter by tracking number only hides rows: what is chosen stays chosen.
 */
export function MoverPaquetes({ barcoOdooId, barcoNombre, almacenPrefijo, lineas, filtroInicial, onVolver }: {
  barcoOdooId: number
  barcoNombre: string
  almacenPrefijo: string
  lineas: LineaEntrega[]
  /** What the list opens filtered by: the filter the delivery had, which may be how the package was found. */
  filtroInicial: string
  /** Back to the delivery of the barco, with nothing moved. */
  onVolver: () => void
}) {
  const router = useRouter()
  const [paso, setPaso] = useState<Paso>('paquetes')
  const [elegidas, setElegidas] = useState<Set<number>>(() => new Set())
  const [filtro, setFiltro] = useState(filtroInicial)
  const [destino, setDestino] = useState<BarcoOpcion | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Made up once. It is not on the screen, so the server and the browser needing a different one does no harm.
  const [id] = useState(() => crypto.randomUUID())
  const [enviando, ejecutar] = useTransition()

  const resumen = resumenSeleccion(lineas, elegidas)
  const visibles = filtrarPorTracking(lineas, filtro)
  // Nothing of what is sent can change while it is sent, nor after it failed and has to be sent again as it was.
  const bloqueado = enviando || error !== null

  // Each step starts at the top, as those of the delivery do.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [paso])

  function elegirBarco(barco: BarcoOpcion) {
    setDestino(barco)
    setPaso('confirmar')
  }

  function confirmar() {
    if (enviando || destino === null || resumen.elegidas === 0) return
    setError(null)
    ejecutar(async () => {
      const resultado = await llamarAccion(() => moverPaquetesAction({
        id,
        barcoOdooId,
        barcoDestinoOdooId: destino.odooId,
        // Only the lines: the server finds what they are in Odoo, and takes no word of it from the phone.
        moveLineIds: resumen.moveLineIds,
      }))
      // The answer has already drawn the barco again; going back is for the moment it did not change what this shows.
      if (resultado.ok) onVolver()
      else setError(resultado.error)
    })
  }

  function cancelar() {
    if (enviando) return
    // A try that failed may have been registered all the same (the answer was lost): the barco is read again, and it says so.
    if (error !== null) router.refresh()
    onVolver()
  }

  if (paso === 'confirmar' && destino !== null) {
    const queSeVan = lineas.filter((linea) => elegidas.has(linea.moveLineId))
    return (
      <>
        <header className="barco-cabecera">
          <button type="button" className="btn-link" disabled={bloqueado} onClick={() => setPaso('barco')}>‹ Otro barco</button>
        </header>

        <div className="entrega-resumen">
          <b>{textoDeConfirmacion({ paquetes: resumen.elegidas, origen: barcoNombre, destino: destino.etiqueta })}</b>
          <span>{almacenPrefijo}</span>
        </div>

        <ul className="list">
          {queSeVan.map((linea) => {
            const { codigo, courier } = textoDeLinea(linea)
            return (
              <li key={linea.moveLineId} className="list-row linea">
                <span className="mono linea-codigo">{codigo}</span>
                {courier ? <span className="badge">{courier}</span> : null}
              </li>
            )
          })}
        </ul>

        <div className="entrega-barra">
          {error ? <p className="banner banner-error" role="alert">{error}</p> : null}
          <button type="button" className="btn btn-primary" disabled={enviando} onClick={confirmar}>
            {enviando ? 'Moviendo…' : error !== null ? 'Reintentar' : 'Confirmar cambio de barco'}
          </button>
          {error !== null ? (
            <button type="button" className="btn btn-secondary" disabled={enviando} onClick={cancelar}>Cancelar</button>
          ) : null}
        </div>
      </>
    )
  }

  if (paso === 'barco') {
    return (
      <>
        <header className="barco-cabecera">
          <button type="button" className="btn-link" onClick={() => setPaso('paquetes')}>‹ Paquetes</button>
        </header>

        <div className="entrega-resumen">
          <b>{textoDePaquetes(resumen.elegidas)} de {barcoNombre}</b>
          <span>¿A qué barco van? · {almacenPrefijo}</span>
        </div>

        <BarcoSearch onElegir={elegirBarco} placeholder="Buscar el barco correcto…" autoFocus excluir={barcoOdooId} />
      </>
    )
  }

  return (
    <>
      <header className="barco-cabecera">
        <button type="button" className="btn-link" onClick={cancelar}>‹ Cancelar</button>
        <h1 className="barco-nombre">{barcoNombre}</h1>
        <span className="barco-almacen">{almacenPrefijo}</span>
      </header>

      <p>Elegí los paquetes que son de otro barco.</p>

      <section className="inicio-seccion" aria-labelledby="mover-rotulo">
        <h2 className="label" id="mover-rotulo">{textoDeSeleccionAMover(resumen)}</h2>
        {mostrarFiltro(lineas.length, filtroInicial) ? (
          <FiltroTracking valor={filtro} onCambiar={setFiltro} visibles={visibles.length} total={lineas.length} />
        ) : null}
        {visibles.length > 0 ? (
          <ul className="list">
            {visibles.map((linea) => (
              <FilaDeLinea
                key={linea.moveLineId}
                linea={linea}
                elegida={elegidas.has(linea.moveLineId)}
                onAlternar={(moveLineId) => setElegidas((actual) => alternarLinea(actual, moveLineId))}
              />
            ))}
          </ul>
        ) : null}
      </section>

      <div className="entrega-barra">
        <button type="button" className="btn btn-primary" disabled={resumen.elegidas === 0} onClick={() => setPaso('barco')}>
          {textoDeElegirBarco(resumen.elegidas)}
        </button>
      </div>
    </>
  )
}
