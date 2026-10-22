'use server'

import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { searchBarcos, type BarcoOpcion } from '@/lib/cache/barcos'

export async function searchBarcosAction(query: string): Promise<BarcoOpcion[]> {
  await requireOperarioFromCookies()
  return searchBarcos(query)
}
