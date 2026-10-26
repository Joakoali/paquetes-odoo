/*
 * What the reception screen decides about the codes the gun fires once the operario has started to leave: Enviar,
 * Descartar, or "Dejar abierta" on a recepción with nothing in it. Each of those closes the recepción, and Next runs the
 * actions of a client one after the other, so a code scanned after the tap is queued behind the action, finds the
 * recepción sent or gone, fails, and is lost with the screen: the package was scanned and is in no recepción.
 *
 * So, from the tap, a code is not sent: it is refused, with a sound and a strip that names it. And the screen does not
 * go away while a refused code has not been seen: it stays, says which codes were not saved, and offers the way back
 * to Recepción, where they can be scanned again. The scans that were sent before the tap are not touched by any of this.
 *
 * This is the state and the decisions, as pure functions over a value that the screen keeps in a ref (the gun may fire
 * between one render and the next, so the decision cannot wait for React state).
 */

/**
 * `abierta`: scans are sent as usual. `cerrando`: a leaving action is under way and what is scanned has nowhere to go.
 * `cerrada`: the leaving action worked; the screen goes on refusing codes until the operario leaves it.
 */
export type FaseDeSalida = 'abierta' | 'cerrando' | 'cerrada'

export interface EstadoDeSalida {
  fase: FaseDeSalida
  /** The codes that were refused, in the order the gun fired them, each once. */
  rechazados: string[]
}

/** A screen where nobody is leaving: where it begins. */
export const RECEPCION_ABIERTA: EstadoDeSalida = { fase: 'abierta', rechazados: [] }

/** The tap on a button that closes the recepción: from now on the codes are not sent. */
export function empezarASalir(estado: EstadoDeSalida): EstadoDeSalida {
  return estado.fase === 'abierta' ? { fase: 'cerrando', rechazados: [] } : estado
}

/** Whether the code the gun fired is sent to the server, and the state after it: a refused code is kept to be told. */
export function decidirEscaneo(estado: EstadoDeSalida, codigo: string): { estado: EstadoDeSalida; despachar: boolean } {
  if (estado.fase === 'abierta') return { estado, despachar: true }
  const rechazados = estado.rechazados.includes(codigo) ? estado.rechazados : [...estado.rechazados, codigo]
  return { estado: { fase: estado.fase, rechazados }, despachar: false }
}

/**
 * The leaving action answered. `funciono`: the recepción is closed. Then the screen leaves, unless a code was refused and
 * nobody has seen it: it stays (`cerrada`) with those codes in `sinGuardar`. If it did not work, the recepción is still
 * open: the screen takes scans again, stays, and gives back the refused codes (`sinGuardar`) to be told with the failure.
 */
export function terminarDeSalir(
  estado: EstadoDeSalida,
  funciono: boolean,
): { estado: EstadoDeSalida; navegar: boolean; sinGuardar: string[] } {
  if (!funciono) return { estado: RECEPCION_ABIERTA, navegar: false, sinGuardar: estado.rechazados }
  return {
    estado: { fase: 'cerrada', rechazados: estado.rechazados },
    navegar: estado.rechazados.length === 0,
    sinGuardar: estado.rechazados,
  }
}

/** What the strip says the moment a code is refused. */
export function textoDeRechazo(codigo: string): string {
  return `No se guardó ${codigo}: llegó mientras se cerraba la recepción.`
}

/** What the screen that is held says when the recepción closed: which codes were not saved, and what to do. */
export function textoDeNoGuardados(codigos: string[]): string {
  if (codigos.length === 1) {
    return `${textoDeRechazo(codigos[0])} Volvé a Recepción y escanealo de nuevo.`
  }
  return `No se guardaron ${codigos.length} códigos: ${codigos.join(', ')}. Llegaron mientras se cerraba la recepción. Volvé a Recepción y escanealos de nuevo.`
}

/** The failure that kept the operario on the screen, with the codes that were refused meanwhile: they can be scanned again here. */
export function agregarNoGuardados(fallo: string, codigos: string[]): string {
  if (codigos.length === 0) return fallo
  if (codigos.length === 1) return `${fallo} No se guardó ${codigos[0]}: escanealo de nuevo.`
  return `${fallo} No se guardaron ${codigos.length} códigos (${codigos.join(', ')}): escanealos de nuevo.`
}
