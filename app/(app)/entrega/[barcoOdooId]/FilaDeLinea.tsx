'use client'

// Type only: lib/odoo/pickings.ts reaches Odoo, which must not get into the client.
import type { LineaEntrega } from '@/lib/odoo/pickings'
import { textoDeLinea } from '@/lib/ui/seleccion-entrega'

/**
 * A line of a list of packages to choose from: its package and its courier, and whether it is chosen. It is touched to
 * change that. A line that is not chosen is drawn apart, and says `textoFuera` instead of its courier when there is one
 * ("en depósito", in the list of what is handed over).
 */
export function FilaDeLinea({ linea, elegida, onAlternar, textoFuera = null }: {
  linea: LineaEntrega
  elegida: boolean
  onAlternar: (moveLineId: number) => void
  textoFuera?: string | null
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
        {!elegida && textoFuera ? <span className="linea-deposito">{textoFuera}</span> : courier ? <span className="badge">{courier}</span> : null}
      </button>
    </li>
  )
}
