'use client'

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { searchBarcosAction } from '@/app/(app)/barcos-actions'
// Type only: lib/cache/barcos.ts reaches the database, which must not get into the client.
import type { BarcoOpcion } from '@/lib/cache/barcos'
import { contadorDePedidos, ESPERA_MS, LETRAS_MINIMAS, textoABuscar } from '@/lib/ui/busqueda-barcos'
import { SIN_RESPUESTA } from '@/lib/ui/textoDeFallo'

/**
 * A field to find a barco by its name, with the results under it as big buttons. It searches from the second letter,
 * 200 ms after the last key, so that typing a name is one request and not one per letter; and what it shows is always
 * the answer to what is in the field now: answers come back in any order, and an old one (`contadorDePedidos`) is
 * thrown away.
 *
 * Each result says `etiqueta`, which is the name with the Odoo id when two barcos have the same name ("H3 · #1234"),
 * so that they can be told apart. The field is not cleared when one is chosen: if what the screen does with it fails,
 * the results are still there to try again.
 *
 * It is typed into with the on-screen keyboard, so a screen that also has a scan field (the home of Recepción) must
 * not let that one take the focus while this one is being used: see `ScanInput`, which leaves any other field alone.
 */
export function BarcoSearch({ onElegir, placeholder, autoFocus = false, deshabilitado = false }: {
  onElegir: (barco: BarcoOpcion) => void
  placeholder: string
  autoFocus?: boolean
  /** While what a choice started is still running: the results are not pressed twice. */
  deshabilitado?: boolean
}) {
  const [texto, setTexto] = useState('')
  const [barcos, setBarcos] = useState<BarcoOpcion[] | null>(null)
  const [buscando, setBuscando] = useState(false)
  const [fallo, setFallo] = useState<string | null>(null)
  const [pedidos] = useState(contadorDePedidos)
  const espera = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Leaving the screen with a request on its way: nobody is left to show it to.
  useEffect(() => () => {
    clearTimeout(espera.current)
    pedidos.nuevo()
  }, [pedidos])

  async function buscar(buscado: string, pedido: number) {
    let encontrados: BarcoOpcion[]
    try {
      encontrados = await searchBarcosAction(buscado)
    } catch (error) {
      // A dropped connection, or a session that expired: the action throws instead of answering.
      if (!pedidos.esVigente(pedido)) return
      console.error('The search of barcos could not be called', error)
      setBarcos(null)
      setFallo(SIN_RESPUESTA)
      setBuscando(false)
      return
    }
    if (!pedidos.esVigente(pedido)) return
    setBarcos(encontrados)
    setFallo(null)
    setBuscando(false)
  }

  function alEscribir(evento: ChangeEvent<HTMLInputElement>) {
    const escrito = evento.target.value
    setTexto(escrito)

    clearTimeout(espera.current)
    // Every key makes the request before it stale, even when this text is too short to search for.
    const pedido = pedidos.nuevo()
    const buscado = textoABuscar(escrito)
    if (buscado === null) {
      setBarcos(null)
      setFallo(null)
      setBuscando(false)
      return
    }

    // What was found for the text before stays on the screen until this one is answered.
    setBuscando(true)
    espera.current = setTimeout(() => void buscar(buscado, pedido), ESPERA_MS)
  }

  const demasiadoCorto = texto.trim().length > 0 && textoABuscar(texto) === null
  const aviso = demasiadoCorto
    ? `Escribí al menos ${LETRAS_MINIMAS} letras.`
    : buscando && barcos === null
      ? 'Buscando…'
      : barcos !== null && barcos.length === 0 && !buscando
        ? 'Ningún barco se llama así.'
        : null

  return (
    <div className="barco-search">
      <input
        type="search"
        className="input"
        aria-label={placeholder}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        autoFocus={autoFocus}
        value={texto}
        onChange={alEscribir}
      />

      <div role="status">
        {aviso ? <p className="busqueda-estado">{aviso}</p> : null}
      </div>
      {fallo ? <p className="banner banner-error" role="alert">{fallo}</p> : null}

      {barcos !== null && barcos.length > 0 ? (
        <ul className="list barcos-resultados" aria-busy={buscando}>
          {barcos.map((barco) => (
            <li key={barco.odooId}>
              <button
                type="button"
                className="list-row barco-resultado"
                disabled={deshabilitado}
                onClick={() => onElegir(barco)}
              >
                {barco.etiqueta}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
