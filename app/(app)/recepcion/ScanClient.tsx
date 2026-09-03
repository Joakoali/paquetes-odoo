// app/(app)/recepcion/ScanClient.tsx
'use client'

import { useRef, useState } from 'react'
import { startSession, startCourierBatch, scanTracking, finishCourierBatch, confirmSession } from './actions'
import { searchBarcosAction } from '../barcos-actions'

interface Almacen { id: number; prefijo: string; nombre: string }
interface Courier { id: number; nombre: string }
interface ScannedItem { trackingNumber: string; estado: 'ok' | 'duplicado' }

export function ScanClient({ almacenes, couriers }: { almacenes: Almacen[]; couriers: Courier[] }) {
  const [almacenId, setAlmacenId] = useState<number | null>(almacenes[0]?.id ?? null)
  const [barcoQuery, setBarcoQuery] = useState('')
  const [barcoOptions, setBarcoOptions] = useState<Array<{ odooId: number; nombre: string }>>([])
  const [barcoOdooId, setBarcoOdooId] = useState<number | null>(null)
  const [sesionId, setSesionId] = useState<string | null>(null)
  const [courierId, setCourierId] = useState<number | null>(null)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [items, setItems] = useState<ScannedItem[]>([])
  const [scanValue, setScanValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  async function onBarcoQueryChange(value: string) {
    setBarcoQuery(value)
    setBarcoOptions(value.length >= 2 ? await searchBarcosAction(value) : [])
  }

  async function onSelectBarco(id: number, nombre: string) {
    setBarcoOdooId(id)
    setBarcoQuery(nombre)
    setBarcoOptions([])
    if (almacenId) setSesionId(await startSession(almacenId, id))
  }

  async function onSelectCourier(id: number) {
    if (!sesionId) return
    setCourierId(id)
    setBatchId(await startCourierBatch(sesionId, id))
    setItems([])
  }

  async function onScanSubmit() {
    if (!batchId || !scanValue.trim()) return
    const result = await scanTracking(batchId, scanValue.trim())
    setItems((prev) => [...prev, { trackingNumber: scanValue.trim(), estado: result.estado }])
    setScanValue('')
    inputRef.current?.focus()
  }

  async function onListo() {
    if (batchId) await finishCourierBatch(batchId)
    setBatchId(null)
    setCourierId(null)
  }

  async function onConfirmarSesion() {
    if (!sesionId) return
    await confirmSession(sesionId)
    setSesionId(null)
    setBarcoOdooId(null)
    setBarcoQuery('')
    setItems([])
  }

  return (
    <main>
      <h1>Recepción</h1>

      <select value={almacenId ?? ''} onChange={(e) => setAlmacenId(Number(e.target.value))}>
        {almacenes.map((a) => <option key={a.id} value={a.id}>{a.prefijo} — {a.nombre}</option>)}
      </select>

      <input
        placeholder="Buscar barco"
        value={barcoQuery}
        onChange={(e) => onBarcoQueryChange(e.target.value)}
      />
      {barcoOptions.map((b) => (
        <button key={b.odooId} onClick={() => onSelectBarco(b.odooId, b.nombre)}>{b.nombre}</button>
      ))}

      {sesionId && !courierId && (
        <div>
          <h2>Elegir courier</h2>
          {couriers.map((c) => (
            <button key={c.id} onClick={() => onSelectCourier(c.id)}>{c.nombre}</button>
          ))}
          <button onClick={onConfirmarSesion} disabled={items.length === 0 && !batchId}>Confirmar sesión</button>
        </div>
      )}

      {courierId && batchId && (
        <div>
          <input
            ref={inputRef}
            autoFocus
            value={scanValue}
            onChange={(e) => setScanValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onScanSubmit() }}
            placeholder="Escanear tracking number"
          />
          <ul>
            {items.map((item, i) => (
              <li key={i} style={{ color: item.estado === 'duplicado' ? 'red' : 'inherit' }}>
                {item.trackingNumber} {item.estado === 'duplicado' && '(duplicado)'}
              </li>
            ))}
          </ul>
          <button onClick={onListo}>Listo</button>
        </div>
      )}
    </main>
  )
}
