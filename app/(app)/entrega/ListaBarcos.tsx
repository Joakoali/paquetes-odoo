'use client'

import Link from 'next/link'
import { useState } from 'react'
// Type only: lib/entrega/entregas.ts reaches the database, which must not get into the client.
import type { BarcoParaEntregar } from '@/lib/entrega/entregas'
import { textoDePaquetes } from '@/lib/ui/cola-escaneo'
import { filtrarBarcos, textoDeEspera, textoDeSinEnviar } from '@/lib/ui/seleccion-entrega'

/**
 * A barco of the list: its name, since when it has packages waiting and how many, and a warning when some are received
 * and not in Odoo yet. It opens the list of its packages. Opening a barco is a live reading of Odoo, so the link is not
 * prefetched: the app would read Odoo for every barco on the screen, one after the other, before anyone chose one.
 */
function FilaDeBarco({ barco, ahora }: { barco: BarcoParaEntregar; ahora: Date }) {
  const sinEnviar = textoDeSinEnviar(barco.sinEnviar)

  return (
    <li>
      <Link href={`/entrega/${barco.barcoOdooId}`} prefetch={false} className="list-row">
        <span className="fila-texto">
          <span className="fila-nombre">{barco.barcoNombre}</span>
          <span className="fila-meta">{textoDeEspera(barco.desde, ahora)}</span>
          {sinEnviar ? <span className="banner banner-warn sin-enviar">{sinEnviar}</span> : null}
        </span>
        <span className="fila-cuenta">{textoDePaquetes(barco.paquetes)}</span>
        <span className="fila-flecha" aria-hidden="true">›</span>
      </Link>
    </li>
  )
}

/**
 * Step 1 of the delivery: the barcos that have packages waiting in the almacén, and a field that filters that list as it
 * is typed in (it is already on the screen, so it asks nothing of the server). `ahora` comes from the server, so that
 * what the times say is the same in the HTML and after it is hydrated.
 */
export function ListaBarcos({ barcos, almacenPrefijo, ahora }: {
  barcos: BarcoParaEntregar[]
  almacenPrefijo: string
  ahora: Date
}) {
  const [texto, setTexto] = useState('')
  const visibles = filtrarBarcos(barcos, texto)

  if (barcos.length === 0) {
    return <p className="lista-vacia">No hay paquetes esperando entrega en {almacenPrefijo}.</p>
  }

  return (
    <section className="inicio-seccion" aria-labelledby="barcos-rotulo">
      <input
        type="search"
        className="input"
        aria-label="Buscar barco…"
        placeholder="Buscar barco…"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        value={texto}
        onChange={(evento) => setTexto(evento.target.value)}
      />

      <h2 className="label" id="barcos-rotulo">
        Para entregar en {almacenPrefijo} · {barcos.length} {barcos.length === 1 ? 'barco' : 'barcos'}
      </h2>

      {visibles.length === 0 ? (
        <p className="busqueda-estado" role="status">Ningún barco de la lista se llama así.</p>
      ) : (
        <ul className="list">
          {visibles.map((barco) => <FilaDeBarco key={barco.barcoOdooId} barco={barco} ahora={ahora} />)}
        </ul>
      )}
    </section>
  )
}
