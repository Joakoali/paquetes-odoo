import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { MIN_CARACTERES_BUSQUEDA, textoDeBusqueda, valorDeLaDireccion } from '@/lib/ui/busqueda-tracking'
import { CampoDeBusqueda } from './CampoDeBusqueda'
import { Resultados } from './Resultados'

/**
 * Where a package is, by its tracking number or a part of it: in the recepciones and entregas of the webapp and in Odoo,
 * for every almacén. `q` of the address is the search. The field is drawn at once and the results after it, in their own
 * Suspense (a new one for each search, `key`): reading Odoo takes a second or two, and the field must stay there for the
 * gun meanwhile.
 */
export default async function BuscarPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  // The layout sends whoever has no valid session to the login, but it does not render again when the operario
  // moves from one tab to another: this is the check that does when the session expired meanwhile.
  const operario = await requireOperarioFromCookies().catch(() => redirect('/login'))
  const escrito = valorDeLaDireccion((await searchParams).q)
  const buscado = textoDeBusqueda(escrito)

  return (
    <main className="page">
      <h1>Buscar paquete</h1>
      <CampoDeBusqueda valor={escrito} />

      {escrito === '' ? (
        <p className="lista-vacia">Escaneá o escribí el tracking nº. Alcanza con los últimos dígitos.</p>
      ) : buscado === null ? (
        <p className="busqueda-estado" role="status">Escribí al menos {MIN_CARACTERES_BUSQUEDA} caracteres.</p>
      ) : (
        <Suspense key={buscado} fallback={<p className="lista-vacia" role="status">Buscando en la webapp y en Odoo…</p>}>
          <Resultados buscado={buscado} escrito={escrito} operario={operario} />
        </Suspense>
      )}
    </main>
  )
}
