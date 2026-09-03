// app/(app)/entrega/EntregaClient.tsx
'use client'

import { useState } from 'react'
import { loadPendingDeliveries, confirmEntregaSession } from './actions'
import { searchBarcosAction } from '../barcos-actions'
import { SignaturePad } from './SignaturePad'

interface Almacen { id: number; prefijo: string; nombre: string }
interface Delivery { id: number; name: string; trackingNumbers: string[] }

export function EntregaClient({ almacenes }: { almacenes: Almacen[] }) {
  const [almacenId, setAlmacenId] = useState<number | null>(almacenes[0]?.id ?? null)
  const [barcoQuery, setBarcoQuery] = useState('')
  const [barcoOptions, setBarcoOptions] = useState<Array<{ odooId: number; nombre: string }>>([])
  const [barcoOdooId, setBarcoOdooId] = useState<number | null>(null)
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [firma, setFirma] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  async function onBarcoQueryChange(value: string) {
    setBarcoQuery(value)
    setBarcoOptions(value.length >= 2 ? await searchBarcosAction(value) : [])
  }

  async function onSelectBarco(id: number, nombre: string) {
    if (!almacenId) return
    setBarcoOdooId(id)
    setBarcoQuery(nombre)
    setBarcoOptions([])
    const pending = await loadPendingDeliveries(almacenId, id)
    setDeliveries(pending)
    setSelected(new Set(pending.map((d) => d.id)))
  }

  async function onConfirmar() {
    if (!almacenId || !barcoOdooId || !firma) return
    await confirmEntregaSession(almacenId, barcoOdooId, Array.from(selected), firma)
    setConfirmed(true)
  }

  if (confirmed) return <p>Entrega confirmada, sincronizando con Odoo.</p>

  return (
    <main>
      <h1>Entrega</h1>
      <select value={almacenId ?? ''} onChange={(e) => setAlmacenId(Number(e.target.value))}>
        {almacenes.map((a) => <option key={a.id} value={a.id}>{a.prefijo} — {a.nombre}</option>)}
      </select>
      <input placeholder="Buscar barco" value={barcoQuery} onChange={(e) => onBarcoQueryChange(e.target.value)} />
      {barcoOptions.map((b) => (
        <button key={b.odooId} onClick={() => onSelectBarco(b.odooId, b.nombre)}>{b.nombre}</button>
      ))}

      {deliveries.length > 0 && (
        <div>
          <h2>Pendiente de entrega</h2>
          {deliveries.map((d) => (
            <label key={d.id} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={selected.has(d.id)}
                onChange={(e) => {
                  const next = new Set(selected)
                  if (e.target.checked) next.add(d.id); else next.delete(d.id)
                  setSelected(next)
                }}
              />
              {d.name} ({d.trackingNumbers.join(', ')})
            </label>
          ))}
          <h2>Firma del receptor</h2>
          <SignaturePad onChange={setFirma} />
          <button onClick={onConfirmar} disabled={!firma || selected.size === 0}>Confirmar entrega</button>
        </div>
      )}
    </main>
  )
}
