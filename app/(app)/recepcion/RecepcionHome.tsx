'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { BarcoSearch } from '@/components/barco-search'
import { CourierPicker } from '@/components/courier-picker'
import { ScanInput } from '@/components/scan-input'
import { haceCuanto } from '@/lib/fechas'
// Types only: these modules reach the database, which must not get into the client.
import type { BarcoOpcion } from '@/lib/cache/barcos'
import type { CourierOpcion } from '@/lib/recepcion/couriers'
import type { RecepcionAbierta, RecepcionEnviada } from '@/lib/recepcion/recepciones'
import { textoDePaquetes } from '@/lib/ui/cola-escaneo'
import { courierInicial, guardarUltimoCourier, leerUltimoCourier } from '@/lib/ui/courier-elegido'
import { noRobarFoco } from '@/lib/ui/foco'
import {
  llevaMasDeUnDia, pasoTrasEscanearSinBarco, resumenDeAbierta, textoDeEnviarTodas, totalesParaEnviar,
} from '@/lib/ui/inicio-recepcion'
import { respuestaDeFallo, SIN_COURIER, type Respuesta } from '@/lib/ui/respuesta-escaneo'
import { prepararSonidos, sonarAviso, sonarOk } from '@/lib/ui/sonidos'
import { llamarAccion } from '@/lib/ui/textoDeFallo'
import { abrirRecepcionAction, asignarYEscanearAction, descartarSiVaciaAction, enviarTodasAction } from './actions'

/** An open recepción: its barco, what it has and for how long, and it opens when touched. After 24 hours the time is a warning. */
function FilaAbierta({ abierta, ahora }: { abierta: RecepcionAbierta; ahora: Date }) {
  const cuanto = `abierta ${haceCuanto(abierta.abiertaDesde, ahora)}`

  return (
    <li>
      <Link href={`/recepcion/${abierta.id}`} className="list-row" onPointerDown={noRobarFoco}>
        <span className="fila-texto">
          <span className="fila-nombre">{abierta.barcoNombre}</span>
          <span className="fila-meta">
            {resumenDeAbierta(abierta)} ·{' '}
            {llevaMasDeUnDia(abierta.abiertaDesde, ahora) ? (
              <span className="banner banner-warn abierta-vieja"><span aria-hidden="true">⚠ </span>{cuanto}</span>
            ) : cuanto}
          </span>
        </span>
        <span className="fila-cuenta">{textoDePaquetes(abierta.paquetes)}</span>
        <span className="fila-flecha" aria-hidden="true">›</span>
      </Link>
    </li>
  )
}

/** How the sync of a recepción that was sent is going. A problem is where the operario goes to see what it is: Pendientes. */
function EstadoDeEnvio({ enviada }: { enviada: RecepcionEnviada }) {
  if (enviada.estado === 'enviando') return <span className="estado-enviando">enviando…</span>
  if (enviada.estado === 'ok') {
    return (
      <span className="estado-ok">
        <span aria-hidden="true">✓ </span>
        <span className="mono">{enviada.odooPickingRef ?? 'enviada'}</span>
      </span>
    )
  }
  return (
    <Link href="/pendientes" className="estado-problema" onPointerDown={noRobarFoco}>
      <span aria-hidden="true">⚠ </span>problema
    </Link>
  )
}

/**
 * What the code that was scanned with no barco chosen waits in: it asks which barco it is for, with the courier it
 * goes under (the one used last is marked already) and the same search as the home. It holds the code until a barco
 * is chosen or it is cancelled. The search field takes the focus: it is the one the operario types in.
 */
function DialogoParaQueBarco({ codigo, couriers, elegidoId, ocupado, error, onElegirCourier, onElegirBarco, onCancelar }: {
  codigo: string
  couriers: { frecuentes: CourierOpcion[]; todos: CourierOpcion[] }
  elegidoId: number | null
  ocupado: boolean
  error: string | null
  onElegirCourier: (courier: CourierOpcion) => void
  onElegirBarco: (barco: BarcoOpcion) => void
  onCancelar: () => void
}) {
  return (
    <div
      className="dialogo-fondo"
      onKeyDown={(evento) => {
        if (evento.key === 'Escape' && !ocupado) onCancelar()
      }}
    >
      <div className="dialogo" role="dialog" aria-modal="true" aria-labelledby="dialogo-titulo">
        <div className="dialogo-cabecera">
          <h2 id="dialogo-titulo">¿Para qué barco es?</h2>
          <button type="button" className="btn-link" disabled={ocupado} onClick={onCancelar}>Cancelar</button>
        </div>

        <p>Paquete <span className="mono dialogo-codigo">{codigo}</span></p>

        <section className="inicio-seccion" aria-labelledby="dialogo-courier">
          <h3 className="label" id="dialogo-courier">Courier</h3>
          <CourierPicker
            frecuentes={couriers.frecuentes}
            todos={couriers.todos}
            elegidoId={elegidoId}
            onElegir={onElegirCourier}
          />
        </section>

        <section className="inicio-seccion" aria-labelledby="dialogo-barco">
          <h3 className="label" id="dialogo-barco">Barco</h3>
          <BarcoSearch autoFocus placeholder="Buscar barco…" onElegir={onElegirBarco} deshabilitado={ocupado} />
        </section>

        {error ? (
          <p className="banner banner-error" role="alert">{error}</p>
        ) : ocupado ? (
          <p className="banner" role="status">Agregando el paquete…</p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The home of Recepción: find a barco to start its recepción, the recepciones that are open (the ones of this almacén,
 * shared by everybody who works in it), the button that sends them all, and what was sent today.
 *
 * The gun works here too, with no barco chosen: its code is held and the dialog asks which barco it is for. The scan
 * field is there to hear it and is not drawn (the home has nothing to type into by hand), and while the dialog is
 * open it is disabled, so that it cannot take the focus from the field of the barcos, where the operario types.
 *
 * Every button that calls an action is disabled while it runs (and while the screen is on its way out), and has no
 * focus to keep (`noRobarFoco`): the Enter of the gun must never press one. `ahora` comes from the server, as the
 * lists do, so that what the times say is the same in the HTML and after it is hydrated.
 */
export function RecepcionHome({ abiertas, enviadas, couriers, ahora }: {
  abiertas: RecepcionAbierta[]
  enviadas: RecepcionEnviada[]
  couriers: { frecuentes: CourierOpcion[]; todos: CourierOpcion[] }
  ahora: Date
}) {
  const router = useRouter()
  const [respuesta, setRespuesta] = useState<Respuesta | null>(null)
  // The code the gun typed while no barco was chosen: not null is what has the dialog open.
  const [codigo, setCodigo] = useState<string | null>(null)
  const [elegidoId, setElegidoId] = useState<number | null>(null)
  const [errorDelDialogo, setErrorDelDialogo] = useState<string | null>(null)
  const [ejecutando, ejecutar] = useTransition()
  // Once the operario is on his way to a recepción, nothing more can be pressed or scanned.
  const [saliendo, setSaliendo] = useState(false)

  const ocupado = ejecutando || saliendo
  const totales = totalesParaEnviar(abiertas)

  useEffect(() => prepararSonidos(), [])

  function mostrar(nueva: Respuesta) {
    setRespuesta(nueva)
    if (nueva.sonido === 'ok') sonarOk()
    else if (nueva.sonido === 'aviso') sonarAviso()
  }

  function irARecepcion(sesionId: string) {
    setSaliendo(true)
    router.push(`/recepcion/${sesionId}`)
  }

  function abrirBarco(barco: BarcoOpcion) {
    if (ocupado) return
    setRespuesta(null)
    ejecutar(async () => {
      const resultado = await llamarAccion(() => abrirRecepcionAction(barco.odooId))
      if (resultado.ok) irARecepcion(resultado.valor.sesionId)
      else mostrar(respuestaDeFallo(resultado.error))
    })
  }

  function enviarTodas() {
    if (ocupado) return
    setRespuesta({ tono: 'neutro', texto: 'Enviando a Odoo…', sonido: null })
    ejecutar(async () => {
      const resultado = await llamarAccion(() => enviarTodasAction())
      if (!resultado.ok) {
        mostrar(respuestaDeFallo(resultado.error))
      } else if (resultado.valor.enviadas === 0) {
        setRespuesta({ tono: 'neutro', texto: 'No había nada para enviar.', sonido: null })
      } else {
        const { enviadas } = resultado.valor
        const cuantas = enviadas === 1 ? 'Se envió 1 recepción' : `Se enviaron ${enviadas} recepciones`
        setRespuesta({ tono: 'ok', texto: `✓ ${cuantas} a Odoo.`, sonido: null })
      }
      // Also when it stopped halfway: what was sent is not open any more.
      router.refresh()
    })
  }

  /** The gun typed a code with no barco chosen: it is held, and the dialog asks for the barco. */
  function alEscanear(escaneado: string) {
    if (saliendo) return
    setRespuesta(null)
    setErrorDelDialogo(null)
    setElegidoId(courierInicial(couriers.frecuentes, couriers.todos, leerUltimoCourier())?.id ?? null)
    setCodigo(escaneado)
  }

  function cancelarDialogo() {
    if (ocupado) return
    setCodigo(null)
    setErrorDelDialogo(null)
  }

  function elegirCourier(courier: CourierOpcion) {
    setElegidoId(courier.id)
    guardarUltimoCourier(courier.id)
  }

  function escanearParaElBarco(barco: BarcoOpcion) {
    if (codigo === null || ocupado) return
    if (elegidoId === null) {
      setErrorDelDialogo(SIN_COURIER)
      return
    }

    setErrorDelDialogo(null)
    ejecutar(async () => {
      const resultado = await llamarAccion(() => asignarYEscanearAction({
        barcoOdooId: barco.odooId,
        courierId: elegidoId,
        trackingNumber: codigo,
      }))
      const siguiente = pasoTrasEscanearSinBarco(resultado, barco.nombre)

      if (siguiente.paso === 'abrir') {
        irARecepcion(siguiente.sesionId)
      } else if (siguiente.paso === 'quedarse') {
        // The code is already in a recepción: nothing went in, and the home says where it is. The recepción this
        // opened for it, if it was new, has nothing in it and is cleaned up (it may also be one with packages).
        setCodigo(null)
        mostrar(siguiente.respuesta)
        await llamarAccion(() => descartarSiVaciaAction(siguiente.sesionId))
      } else {
        // The code stays held, so that the operario can try again or cancel.
        setErrorDelDialogo(siguiente.mensaje)
        sonarAviso()
      }
    })
  }

  return (
    <>
      <BarcoSearch placeholder="Buscar barco para empezar una recepción…" onElegir={abrirBarco} deshabilitado={ocupado} />

      <div role="status">
        {respuesta ? (
          <p className={`banner respuesta${respuesta.tono === 'ok' ? ' banner-ok' : respuesta.tono === 'error' ? ' banner-error' : ''}`}>
            {respuesta.texto}
          </p>
        ) : null}
      </div>

      <section className="inicio-seccion" aria-labelledby="abiertas-rotulo">
        <h2 className="label" id="abiertas-rotulo">Recepciones abiertas · {abiertas.length}</h2>
        {abiertas.length === 0 ? (
          <p className="lista-vacia">No hay ninguna abierta. Escaneá un paquete o buscá un barco para empezar.</p>
        ) : (
          <ul className="list">
            {abiertas.map((abierta) => <FilaAbierta key={abierta.id} abierta={abierta} ahora={ahora} />)}
          </ul>
        )}
      </section>

      {totales.recepciones > 0 ? (
        <button type="button" className="btn btn-primary inicio-enviar" disabled={ocupado} onPointerDown={noRobarFoco} onClick={enviarTodas}>
          {textoDeEnviarTodas(totales)}
        </button>
      ) : null}

      <section className="inicio-seccion" aria-labelledby="enviadas-rotulo">
        <h2 className="label" id="enviadas-rotulo">Enviadas hoy</h2>
        {enviadas.length === 0 ? (
          <p className="lista-vacia">Todavía no se envió ninguna recepción hoy.</p>
        ) : (
          <ul className="list">
            {enviadas.map((enviada) => (
              <li key={enviada.id} className="enviada">
                <span className="fila-texto">
                  <span className="fila-nombre">{enviada.barcoNombre}</span>
                  <span className="fila-meta">{textoDePaquetes(enviada.paquetes)}</span>
                </span>
                <EstadoDeEnvio enviada={enviada} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* To hear the gun, not to be seen (the home has nothing to type into by hand). */}
      <div className="scan-oculto">
        <ScanInput onCodigo={alEscanear} deshabilitado={codigo !== null} />
      </div>

      {codigo !== null ? (
        <DialogoParaQueBarco
          codigo={codigo}
          couriers={couriers}
          elegidoId={elegidoId}
          ocupado={ocupado}
          error={errorDelDialogo}
          onElegirCourier={elegirCourier}
          onElegirBarco={escanearParaElBarco}
          onCancelar={cancelarDialogo}
        />
      ) : null}
    </>
  )
}
