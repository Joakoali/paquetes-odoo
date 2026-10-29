'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { FiltroTracking } from '@/components/filtro-tracking'
import { SignaturePad } from '@/components/signature-pad'
// Type only: lib/odoo/pickings.ts reaches Odoo, which must not get into the client.
import type { LineaEntrega } from '@/lib/odoo/pickings'
import { filtrarPorTracking, mostrarFiltro } from '@/lib/ui/busqueda-tracking'
import { textoDePaquetes } from '@/lib/ui/cola-escaneo'
import {
  alternarLinea, MAX_NOMBRE_RECEPTOR, puedeConfirmar, resumenSeleccion, textoDeAvisoSinEnviar, textoDeEnviandose, textoDeLinea,
  textoDeSeleccion, textoDeSiguiente, textoSinPaquetes,
} from '@/lib/ui/seleccion-entrega'
import { llamarAccion, sinRespuesta } from '@/lib/ui/textoDeFallo'
import { confirmarEntregaAction, enviarRecepcionesDelBarcoAction } from '../actions'

type Paso = 'paquetes' | 'firma' | 'hecho'

/** What "Enviar ahora" answered, under the strip that offered it. */
interface Aviso {
  tono: 'ok' | 'error'
  texto: string
  /** The packages that were sent take a minute to be in Odoo: this is the way to look again, with no way to reload the app. */
  actualizar: boolean
}

/** How long "Entrega registrada" stays on the screen before the list of barcos comes back. */
const ESPERA_ANTES_DE_VOLVER_MS = 2000

/** A line of the list: its package and courier, and whether it is handed over or stays in depósito. It is touched to change that. */
function FilaDeLinea({ linea, elegida, onAlternar }: {
  linea: LineaEntrega
  elegida: boolean
  onAlternar: (moveLineId: number) => void
}) {
  const { codigo, courier } = textoDeLinea(linea)

  return (
    <li>
      <button
        type="button"
        role="checkbox"
        aria-checked={elegida}
        className={`list-row linea${elegida ? '' : ' linea-fuera'}`}
        onClick={() => onAlternar(linea.moveLineId)}
      >
        <span className="linea-caja" aria-hidden="true">✓</span>
        <span className="mono linea-codigo">{codigo}</span>
        {elegida ? (courier ? <span className="badge">{courier}</span> : null) : <span className="linea-deposito">en depósito</span>}
      </button>
    </li>
  )
}

/**
 * Steps 2 and 3 of the delivery, on the phone, and what follows them:
 *
 * - `paquetes`: every line Odoo has waiting for the barco, all of them chosen; touching one leaves it in depósito.
 * - `firma`: the name of who receives and their signature, and the button that confirms.
 * - `hecho`: "Entrega registrada", and back to the list of barcos, where it shows under "Entregadas hoy".
 *
 * Confirming must lose nothing and make nothing twice. The `id` is made up once, here, before the first try, and every try
 * (the first one and each "Reintentar") sends that same id: the domain saves one entrega per id. If the answer is a failure,
 * or no answer comes at all, the name, the signature and the choice stay as they are on the screen. They are also locked
 * while it is sending and after it failed, so that the retry sends exactly what the first try did (the server keeps the
 * entrega it saved the first time, and a name or a signature changed since would look sent when it was not). The button is
 * disabled while a try is on its way: a second touch does not send a second time.
 *
 * The filter by tracking number only hides rows. What is chosen, what "Se entregan" counts and what is signed for are all
 * the lines, the hidden ones included: a package that is filtered out is still handed over if it is chosen.
 */
export function EntregaFlow({ barcoOdooId, barcoNombre, almacenPrefijo, lineas, sinEnviar, enviandose, filtroInicial }: {
  barcoOdooId: number
  barcoNombre: string
  almacenPrefijo: string
  lineas: LineaEntrega[]
  /** The packages of the barco received and not sent to Odoo yet: they are not in `lineas`. */
  sinEnviar: number
  /** The packages Odoo still lists that an entrega already confirmed is taking to Odoo: they are not in `lineas`, so they cannot be handed over twice. */
  enviandose: number
  /** What the list opens filtered by: the `q` of the address, which is how the search of a package leads here. */
  filtroInicial: string
}) {
  const router = useRouter()
  const [paso, setPaso] = useState<Paso>('paquetes')
  const [elegidas, setElegidas] = useState<Set<number>>(() => new Set(lineas.map((linea) => linea.moveLineId)))
  const [filtro, setFiltro] = useState(filtroInicial)
  const [receptor, setReceptor] = useState('')
  const [firma, setFirma] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<Aviso | null>(null)
  // Made up once. It is not on the screen, so the server and the browser needing a different one does no harm.
  const [id] = useState(() => crypto.randomUUID())
  const [enviando, ejecutar] = useTransition()

  const resumen = resumenSeleccion(lineas, elegidas)
  const visibles = filtrarPorTracking(lineas, filtro)
  // Nothing of what is sent can change while it is sent, nor after it failed and has to be sent again as it was.
  const bloqueado = enviando || error !== null

  // Each step starts at the top: the list of packages can be long, and the next step is shorter.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [paso])

  useEffect(() => {
    if (paso !== 'hecho') return
    // Replaced and not pushed: with this barco page in the history, "Atrás" would bring it back as the browser kept it, with
    // every package chosen and a fresh id, one tap away from a second entrega of the same packages.
    const espera = setTimeout(() => router.replace('/entrega'), ESPERA_ANTES_DE_VOLVER_MS)
    return () => clearTimeout(espera)
  }, [paso, router])

  function enviarAhora() {
    if (enviando) return
    setAviso(null)
    ejecutar(async () => {
      const resultado = await llamarAccion(() => enviarRecepcionesDelBarcoAction(barcoOdooId))
      if (!resultado.ok) {
        setAviso({ tono: 'error', texto: resultado.error, actualizar: false })
      } else if (resultado.valor.enviadas === 0) {
        setAviso({ tono: 'ok', texto: 'No había nada para enviar: ya se enviaron.', actualizar: true })
      } else {
        setAviso({ tono: 'ok', texto: '✓ Enviado a Odoo. Los paquetes tardan alrededor de un minuto en aparecer acá.', actualizar: true })
      }
      // Also when it stopped halfway, what was sent is not unsent any more. The action draws this screen again in its
      // answer in any case (`refresh`), Odoo included: reading it once more would wait for Odoo a second time. Only a
      // call that got no answer needs it.
      if (sinRespuesta(resultado)) router.refresh()
    })
  }

  function volverALosPaquetes() {
    if (bloqueado) return
    // What was signed was a choice of packages: if it changes, the signature is made again.
    setFirma(null)
    setPaso('paquetes')
  }

  function confirmar() {
    if (enviando || firma === null || !puedeConfirmar({ receptor, firma, elegidas: resumen.elegidas })) return
    setError(null)
    ejecutar(async () => {
      const resultado = await llamarAccion(() => confirmarEntregaAction({
        id,
        barcoOdooId,
        // Only the lines: the server finds the deliveries they are on in Odoo, and takes no word of it from the phone.
        moveLineIds: resumen.moveLineIds,
        receptorNombre: receptor,
        firmaDataUrl: firma,
      }))
      // A failure leaves everything where it is: the name, the signature and the choice, for "Reintentar".
      if (resultado.ok) setPaso('hecho')
      else setError(resultado.error)
    })
  }

  if (paso === 'hecho') {
    return (
      <>
        <p className="banner banner-ok respuesta" role="status">✓ Entrega registrada, enviándose a Odoo</p>
        <p className="lista-vacia">
          {textoDePaquetes(resumen.elegidas)} de {barcoNombre}. Figura en «Entregadas hoy» de la lista de barcos.
        </p>
        <div className="actions">
          <Link href="/entrega" replace className="btn btn-primary">Volver a Entrega</Link>
        </div>
      </>
    )
  }

  if (paso === 'firma') {
    return (
      <>
        <header className="barco-cabecera">
          <button type="button" className="btn-link" disabled={bloqueado} onClick={volverALosPaquetes}>‹ Paquetes</button>
        </header>

        <div className="entrega-resumen">
          <b>{barcoNombre}</b>
          <span>{textoDePaquetes(resumen.elegidas)} · {almacenPrefijo}</span>
        </div>

        <section>
          <label className="label" htmlFor="receptor">Nombre de quien recibe</label>
          <input
            id="receptor"
            type="text"
            className="input"
            value={receptor}
            maxLength={MAX_NOMBRE_RECEPTOR}
            autoComplete="off"
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            disabled={bloqueado}
            onChange={(evento) => setReceptor(evento.target.value)}
            // The keyboard goes away with "Listo", and the box to sign in is in view.
            onKeyDown={(evento) => {
              if (evento.key === 'Enter') evento.currentTarget.blur()
            }}
          />
        </section>

        {/* The one that grows: the box takes the height that is left on the screen. */}
        <section className="entrega-firma">
          <p className="label">Firma</p>
          <SignaturePad onChange={setFirma} deshabilitado={bloqueado} />
        </section>

        <div className="entrega-barra">
          {error ? <p className="banner banner-error" role="alert">{error}</p> : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={enviando || !puedeConfirmar({ receptor, firma, elegidas: resumen.elegidas })}
            onClick={confirmar}
          >
            {enviando ? 'Confirmando…' : error !== null ? 'Reintentar' : 'Confirmar entrega'}
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <header className="barco-cabecera">
        <Link href="/entrega" className="btn-link">‹ Entrega</Link>
        <h1 className="barco-nombre">{barcoNombre}</h1>
        <span className="barco-almacen">{almacenPrefijo}</span>
      </header>

      {sinEnviar > 0 ? (
        <div className="banner banner-warn entrega-franja">
          <p>{textoDeAvisoSinEnviar(sinEnviar)}</p>
          <button type="button" className="btn btn-secondary" disabled={enviando} onClick={enviarAhora}>
            {enviando ? 'Enviando…' : 'Enviar ahora'}
          </button>
        </div>
      ) : null}

      {enviandose > 0 ? <p className="banner banner-ok" role="status">{textoDeEnviandose(enviandose)}</p> : null}

      {aviso ? (
        <div className={`banner ${aviso.tono === 'ok' ? 'banner-ok' : 'banner-error'} entrega-franja`} role={aviso.tono === 'ok' ? 'status' : 'alert'}>
          <p>{aviso.texto}</p>
          {aviso.actualizar ? <button type="button" className="btn-link" onClick={() => router.refresh()}>Actualizar</button> : null}
        </div>
      ) : null}

      {lineas.length === 0 ? (
        <p className="lista-vacia">{textoSinPaquetes(enviandose)}</p>
      ) : (
        <section className="inicio-seccion" aria-labelledby="paquetes-rotulo">
          <h2 className="label" id="paquetes-rotulo">{textoDeSeleccion(resumen)}</h2>
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
      )}

      <div className="entrega-barra">
        <button type="button" className="btn btn-primary" disabled={resumen.elegidas === 0} onClick={() => setPaso('firma')}>
          {textoDeSiguiente(resumen.elegidas)}
        </button>
      </div>
    </>
  )
}
