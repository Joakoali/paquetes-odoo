import { db } from './client'
import { almacenes, couriers } from './schema'

const ALMACENES = [
  { prefijo: 'MB92', nombre: 'Barcelona (MB92)' },
  { prefijo: 'IBZ', nombre: 'Ibiza / Baleares' },
  { prefijo: 'MPV', nombre: 'Marina Port Vell (Barcelona)' },
  { prefijo: 'VLN', nombre: 'Pendennis Vilanova' },
  { prefijo: 'MLC', nombre: 'Mallorca (MLC)' },
  { prefijo: 'MLR', nombre: 'Mallorca (MLR)' },
  { prefijo: 'MLG', nombre: 'Málaga' },
]

const COURIERS = [
  'Amazon', 'Correos', 'DHL', 'GLS', 'SEUR', 'PAACK', 'MRW',
  'CTT Express', 'UPS', 'BPOST', 'FedEx', 'Deutsche Post', 'Royal Mail',
]

async function seed() {
  await db.insert(almacenes).values(ALMACENES).onConflictDoNothing()
  await db.insert(couriers).values(COURIERS.map((nombre) => ({ nombre }))).onConflictDoNothing()
  console.log('Seed complete')
}

seed()
