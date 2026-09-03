'use server'

import { searchBarcos } from '@/lib/cache/barcos'

export async function searchBarcosAction(
  query: string,
): Promise<{ odooId: number; nombre: string }[]> {
  return searchBarcos(query)
}
