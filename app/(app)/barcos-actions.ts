'use server'

import { requireOperarioFromCookies } from '@/lib/auth/current-operario'
import { searchBarcos } from '@/lib/cache/barcos'

export async function searchBarcosAction(
  query: string,
): Promise<{ odooId: number; nombre: string }[]> {
  await requireOperarioFromCookies()
  return searchBarcos(query)
}
