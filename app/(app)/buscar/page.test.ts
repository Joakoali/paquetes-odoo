import { beforeEach, describe, expect, it, vi } from 'vitest'

// What reaches the session, the database, Odoo or the browser is replaced: what is tested is what the page decides. The
// field and the results are drawn as nothing here; each is tested on its own.
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/auth/current-operario', () => ({ requireOperarioFromCookies: vi.fn() }))
vi.mock('./CampoDeBusqueda', () => ({ CampoDeBusqueda: vi.fn() }))
vi.mock('./Resultados', () => ({ Resultados: vi.fn() }))

import { isValidElement, Suspense, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { redirect } from 'next/navigation'
import type { Operario } from '@/db/schema'
import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { UnauthorizedError } from '@/lib/auth/guards'
import { CampoDeBusqueda } from './CampoDeBusqueda'
import BuscarPage from './page'
import { Resultados } from './Resultados'

const operario = { id: 'operario-1', nombre: 'Veronika', rol: 'operario' } as Operario

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireOperarioFromCookies).mockResolvedValue(operario)
  vi.mocked(redirect).mockImplementation((destino) => {
    throw new Error(`NEXT_REDIRECT ${destino}`)
  })
})

/** The page for the `q` of the address, if it has one. Next hands it as a promise. */
const pagina = (q?: string | string[]) => BuscarPage({ searchParams: Promise.resolve(q === undefined ? {} : { q }) })

/** The first element of the tree that is of this type, or undefined. */
function buscar(nodo: ReactNode, tipo: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(nodo)) return nodo.map((hijo) => buscar(hijo, tipo)).find((encontrado) => encontrado !== undefined)
  if (!isValidElement<Record<string, unknown>>(nodo)) return undefined
  if (nodo.type === tipo) return nodo
  return buscar(nodo.props.children as ReactNode, tipo)
}

describe('BuscarPage', () => {
  it('sends whoever has no valid session to the login', async () => {
    vi.mocked(requireOperarioFromCookies).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

    await expect(pagina('0588')).rejects.toThrow('NEXT_REDIRECT /login')
  })

  it('has the field and says what to do, and searches nothing, when the address has no search', async () => {
    const resultado = await pagina()

    expect(buscar(resultado, CampoDeBusqueda)?.props).toEqual({ valor: '' })
    expect(renderToStaticMarkup(resultado as ReactElement)).toContain('Escaneá o escribí el tracking nº. Alcanza con los últimos dígitos.')
    expect(buscar(resultado, Resultados)).toBeUndefined()
  })

  it('asks for more and searches nothing for less than four characters, blanks aside', async () => {
    const resultado = await pagina(' 0 5 8 ')

    expect(buscar(resultado, CampoDeBusqueda)?.props).toEqual({ valor: '0 5 8' })
    expect(renderToStaticMarkup(resultado as ReactElement)).toContain('Escribí al menos 4 caracteres.')
    expect(buscar(resultado, Resultados)).toBeUndefined()
  })

  it('searches what was typed, normalized, for the operario, and keeps what was typed to say it back', async () => {
    const resultado = await pagina(' JJD 0588 ')

    expect(buscar(resultado, CampoDeBusqueda)?.props).toEqual({ valor: 'JJD 0588' })
    expect(buscar(resultado, Resultados)?.props).toEqual({ buscado: 'jjd0588', escrito: 'JJD 0588', operario })
  })

  it('takes the first search when the address has it twice', async () => {
    expect(buscar(await pagina(['0588', '1234']), Resultados)?.props).toMatchObject({ buscado: '0588' })
  })

  it('draws the results in a Suspense of their own for each search, with what is being done while Odoo is read', async () => {
    const espera = buscar(await pagina('0588'), Suspense)

    expect(espera?.key).toBe('0588')
    expect(renderToStaticMarkup(espera?.props.fallback as ReactElement)).toContain('Buscando en la webapp y en Odoo…')
  })
})
