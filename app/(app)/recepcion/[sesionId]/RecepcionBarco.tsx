'use client'

import { useEffect, useReducer, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CourierPicker } from '@/components/courier-picker'
import { ScanInput, type ScanInputHandle } from '@/components/scan-input'
// Types only: these modules reach the database, which must not get into the client.
import type { CourierOpcion } from '@/lib/recepcion/couriers'
import type { RecepcionDetalle } from '@/lib/recepcion/recepciones'
import {
  claveNueva, colaReducer, contarFilas, filasIniciales, rotuloDeLaLista, textoDePaquetes, type FilaEscaneo,
} from '@/lib/ui/cola-escaneo'
import { courierInicial, guardarUltimoCourier, leerUltimoCourier } from '@/lib/ui/courier-elegido'
import { noRobarFoco } from '@/lib/ui/foco'
import {
  respuestaDeEscaneo, respuestaDeFallo, SIN_COURIER, textoDeDuplicado, type Respuesta,
} from '@/lib/ui/respuesta-escaneo'
import {
  agregarNoGuardados, decidirEscaneo, empezarASalir, RECEPCION_ABIERTA, terminarDeSalir, textoDeNoGuardados, textoDeRechazo,
} from '@/lib/ui/salida-recepcion'
import { prepararSonidos, sonarAviso, sonarOk } from '@/lib/ui/sonidos'
import { llamarAccion, textoDeFallo } from '@/lib/ui/textoDeFallo'
import {
  borrarPaqueteAction, descartarRecepcionAction, descartarSiVaciaAction, enviarRecepcionAction, escanearAction,
} from '../actions'
import { CabeceraDeBarco } from './CabeceraDeBarco'

const SIN_PAQUETES_VALIDOS = 'No hay nada para enviar: los paquetes que escaneaste ya están en Odoo.'

/** A package of the list: its code, its courier, and what there is to say about it (verifying, duplicate, error). */
function FilaDePaquete({ fila, ocupado, onBorrar }: {
  fila: FilaEscaneo
  ocupado: boolean
  onBorrar: (fila: FilaEscaneo) => void
}) {
  const aviso = fila.estado === 'duplicado' ? textoDeDuplicado(fila.detalle) : fila.estado === 'error' ? fila.detalle : null

  return (
    <li className={`paquete paquete-${fila.estado}`}>
      <span className="mono paquete-codigo">
        {fila.estado === 'duplicado' || fila.estado === 'error' ? <span aria-hidden="true">⚠ </span> : null}
        {fila.trackingNumber}
      </span>
      <span className="badge">{fila.courierNombre}</span>
      {fila.estado === 'verificando' ? <span className="paquete-estado">verificando…</span> : null}
      {aviso ? <span className="paquete-estado">{aviso}</span> : null}
      {fila.itemId !== null ? (
        <button
          type="button"
          className="btn-link paquete-borrar"
          aria-label={`Quitar ${fila.trackingNumber}`}
          disabled={ocupado}
          onPointerDown={noRobarFoco}
          onClick={() => onBorrar(fila)}
        >
          ✕
        </button>
      ) : null}
    </li>
  )
}

/**
 * The screen where the packages of one barco are scanned, on a tablet with a barcode gun (the gun types the code and
 * presses Enter, like a keyboard). In order: the header, the courier, the scan field, what happened to the last
 * scan, the packages, and what to do with the recepción.
 *
 * Every code makes its row at once, `verificando`, and what the server answers settles it later (`colaReducer`): the
 * gun may fire again while the last code is still being checked, and each code must show up once, in order. The scan
 * field is never disabled for that reason. What a button does is done on `click`, with the buttons not taking the
 * focus (`noRobarFoco`), so the Enter of the gun can never press one.
 *
 * The recepción is shared: it belongs to the almacén and the barco, and anybody who has the almacén may scan into it.
 * What is on the screen is what this tablet scanned and what was there when it opened; another tablet's scans show
 * up when the page is loaded again.
 *
 * Enviar, Descartar and "Dejar abierta" on an empty recepción close it, and the gun can fire while they run: a code
 * sent then would queue behind the action, find the recepción closed, and be lost with the screen. From the tap, a code
 * is not sent (`salida-recepcion`): it is refused with the warning sound and a strip that names it, and the screen
 * does not go away while a refused code has not been seen: it says which were not saved and how to go back to scan
 * them again.
 */
export function RecepcionBarco({ recepcion, couriers }: {
  recepcion: RecepcionDetalle
  couriers: { frecuentes: CourierOpcion[]; todos: CourierOpcion[] }
}) {
  const router = useRouter()
  const scan = useRef<ScanInputHandle>(null)
  const [filas, dispatch] = useReducer(colaReducer, recepcion.paquetes, filasIniciales)
  // The first frequent one is what the server (and the first render) can know; the device's own choice comes next.
  const [elegidoId, setElegidoId] = useState<number | null>(
    () => courierInicial(couriers.frecuentes, couriers.todos, null)?.id ?? null,
  )
  const [respuesta, setRespuesta] = useState<Respuesta | null>(null)
  const [ejecutando, ejecutar] = useTransition()
  // Once the operario is on his way out, nothing more can be pressed.
  const [saliendo, setSaliendo] = useState(false)
  // Where the screen is in leaving, kept in a ref because the gun can fire between one render and the next: the decision
  // to refuse a code cannot wait for React.
  const salida = useRef(RECEPCION_ABIERTA)
  // The codes refused while the recepción closed, once it did: the screen is held with them in view until the operario goes.
  const [sinGuardar, setSinGuardar] = useState<string[] | null>(null)

  const ocupado = ejecutando || saliendo || sinGuardar !== null
  const conteo = contarFilas(filas)
  const elegido = couriers.todos.find((courier) => courier.id === elegidoId) ?? null

  useEffect(() => prepararSonidos(), [])

  // The courier used last on this device. Not in the first render: the server does not know it, and the two must match.
  useEffect(() => {
    const ultimo = courierInicial(couriers.frecuentes, couriers.todos, leerUltimoCourier())
    setElegidoId(ultimo?.id ?? null)
  }, [])

  function mostrar(nueva: Respuesta) {
    setRespuesta(nueva)
    if (nueva.sonido === 'ok') sonarOk()
    else if (nueva.sonido === 'aviso') sonarAviso()
  }

  function elegirCourier(courier: CourierOpcion) {
    setElegidoId(courier.id)
    guardarUltimoCourier(courier.id)
    scan.current?.enfocar()
  }

  /** Not awaited by the field: the next code may arrive while this one is still being checked. */
  async function escanear(codigo: string) {
    const decision = decidirEscaneo(salida.current, codigo)
    salida.current = decision.estado
    if (!decision.despachar) {
      // The recepción is closing: this code has nowhere to go. It is told now, and kept to be told again if the screen stays.
      mostrar(respuestaDeFallo(textoDeRechazo(codigo)))
      if (decision.estado.fase === 'cerrada') setSinGuardar(decision.estado.rechazados)
      return
    }

    if (elegido === null) {
      mostrar(respuestaDeFallo(SIN_COURIER))
      return
    }

    const clave = claveNueva()
    dispatch({ tipo: 'escaneado', clave, trackingNumber: codigo, courierId: elegido.id, courierNombre: elegido.nombre })

    const resultado = await llamarAccion(() => escanearAction({
      sesionId: recepcion.id,
      courierId: elegido.id,
      trackingNumber: codigo,
    }))
    if (!resultado.ok) {
      dispatch({ tipo: 'fallido', clave, mensaje: resultado.error })
      mostrar(respuestaDeFallo(resultado.error))
      return
    }
    dispatch({ tipo: 'resuelto', clave, resultado: resultado.valor })
    mostrar(respuestaDeEscaneo(resultado.valor))
  }

  function borrar(fila: FilaEscaneo) {
    const itemId = fila.itemId
    if (itemId === null) return
    setRespuesta(null)
    ejecutar(async () => {
      const fallo = await textoDeFallo(borrarPaqueteAction, itemId)
      if (fallo === null) dispatch({ tipo: 'borrado', itemId })
      else mostrar(respuestaDeFallo(fallo))
      scan.current?.enfocar()
    })
  }

  function irAlInicio() {
    setSaliendo(true)
    router.push('/recepcion')
  }

  /** What a button that was to leave the screen does when it did not work: say why, stay, and be ready to scan. */
  function quedarseConElFallo(fallo: string) {
    mostrar(respuestaDeFallo(fallo))
    scan.current?.enfocar()
  }

  /**
   * What a button that closes the recepción does when its action answered. If it worked the screen goes to the start,
   * unless a code was refused meanwhile: then it stays, with those codes in view. If it did not, the recepción is still
   * open: the screen says why, with the codes that were refused (they can be scanned again here), and takes scans again.
   */
  function terminarSalida(funciono: boolean, fallo = '') {
    const fin = terminarDeSalir(salida.current, funciono)
    salida.current = fin.estado
    if (!funciono) quedarseConElFallo(agregarNoGuardados(fallo, fin.sinGuardar))
    else if (fin.navegar) irAlInicio()
    else setSinGuardar(fin.sinGuardar)
  }

  function enviar() {
    setRespuesta({ tono: 'neutro', texto: 'Enviando a Odoo…', sonido: null })
    salida.current = empezarASalir(salida.current)
    ejecutar(async () => {
      const resultado = await llamarAccion(() => enviarRecepcionAction(recepcion.id))
      if (!resultado.ok) {
        terminarSalida(false, resultado.error)
      } else if (resultado.valor === 'sin_paquetes_validos') {
        // Only duplicados in it: there is nothing to send, and it stays open for somebody to look at.
        terminarSalida(false, SIN_PAQUETES_VALIDOS)
      } else {
        terminarSalida(true)
      }
    })
  }

  function dejarAbierta() {
    // With packages there is nothing to do but go. With none, the recepción is cleaned up, but only if it is
    // really empty: a colleague may have scanned into it, and `descartarSiVaciaAction` cannot lose that.
    if (conteo.enRecepcion > 0) {
      irAlInicio()
      return
    }
    setRespuesta(null)
    salida.current = empezarASalir(salida.current)
    ejecutar(async () => {
      const fallo = await textoDeFallo(descartarSiVaciaAction, recepcion.id)
      terminarSalida(fallo === null, fallo ?? '')
    })
  }

  function descartar() {
    const que = conteo.enRecepcion === 0 ? '' : ` con ${textoDePaquetes(conteo.enRecepcion)}`
    if (!window.confirm(`¿Descartar la recepción de ${recepcion.barcoNombre}${que}? No se puede deshacer.`)) {
      scan.current?.enfocar()
      return
    }
    setRespuesta(null)
    salida.current = empezarASalir(salida.current)
    ejecutar(async () => {
      const fallo = await textoDeFallo(descartarRecepcionAction, recepcion.id)
      terminarSalida(fallo === null, fallo ?? '')
    })
  }

  return (
    <>
      <CabeceraDeBarco barcoNombre={recepcion.barcoNombre} almacenPrefijo={recepcion.almacenPrefijo} />

      {sinGuardar !== null ? (
        // The recepción closed while the gun was still firing: the screen waits here until the operario has read which codes
        // were not saved. The scan field goes on taking codes (and refusing them), so that nothing typed goes nowhere.
        <div className="banner banner-error recepcion-sin-guardar" role="alert">
          <p>{textoDeNoGuardados(sinGuardar)}</p>
          <button type="button" className="btn btn-primary" disabled={saliendo} onPointerDown={noRobarFoco} onClick={irAlInicio}>
            Volver a Recepción
          </button>
        </div>
      ) : null}

      <section aria-labelledby="courier-rotulo">
        <p className="label" id="courier-rotulo">Courier (queda marcado hasta que lo cambies)</p>
        <CourierPicker
          frecuentes={couriers.frecuentes}
          todos={couriers.todos}
          elegidoId={elegidoId}
          onElegir={elegirCourier}
        />
      </section>

      <ScanInput ref={scan} onCodigo={escanear} />

      {/* Always there, with room for the strip: what is below it must not jump at every scan. */}
      <div className="respuesta-lugar" role="status" aria-live="polite">
        {respuesta ? (
          <p className={`banner respuesta${respuesta.tono === 'ok' ? ' banner-ok' : respuesta.tono === 'error' ? ' banner-error' : ''}`}>
            {respuesta.texto}
          </p>
        ) : null}
      </div>

      <section aria-labelledby="paquetes-rotulo">
        <p className="label" id="paquetes-rotulo">{rotuloDeLaLista(conteo)}</p>
        {filas.length === 0 ? (
          <p className="lista-vacia">Todavía no escaneaste ningún paquete.</p>
        ) : (
          <ul className="list paquetes-lista">
            {filas.map((fila) => (
              <FilaDePaquete key={fila.clave} fila={fila} ocupado={ocupado} onBorrar={borrar} />
            ))}
          </ul>
        )}
      </section>

      <div className="actions recepcion-acciones">
        <button type="button" className="btn btn-secondary" disabled={ocupado} onPointerDown={noRobarFoco} onClick={dejarAbierta}>
          Dejar abierta
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={ocupado || conteo.paraEnviar === 0}
          onPointerDown={noRobarFoco}
          onClick={enviar}
        >
          Enviar a Odoo · {textoDePaquetes(conteo.paraEnviar)}
        </button>
      </div>

      <div className="recepcion-descartar">
        <button type="button" className="btn-link" disabled={ocupado} onPointerDown={noRobarFoco} onClick={descartar}>
          Descartar recepción
        </button>
      </div>
    </>
  )
}
