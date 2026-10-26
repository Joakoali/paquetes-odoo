import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface VercelConfig {
  crons: Array<{ path: string; schedule: string }>
}

const config: VercelConfig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../vercel.json', import.meta.url)), 'utf8'))

describe('the schedule of the refresh of the caches in vercel.json', () => {
  const cron = config.crons.find((c) => c.path === '/api/cron/refresh-caches')

  it('is there', () => {
    expect(cron).toBeDefined()
  })

  // Spec 6.5 asks for a nightly load. The refresh reads all of Odoo, one request a second, through the queue the sends
  // use: at the start of the working day (06:00 UTC is 07:00 or 08:00 in Madrid) it would delay the first sends.
  it('runs once a day, at night: between 00:00 and 04:59 UTC, which is 01:00 to 06:59 in Madrid', () => {
    const partes = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron?.schedule ?? '')

    expect(partes, `"${cron?.schedule}" is not a daily schedule`).not.toBeNull()
    const hora = Number(partes?.[2])
    expect(hora).toBeGreaterThanOrEqual(0)
    expect(hora).toBeLessThan(5)
  })

  it('is at 02:00 UTC', () => {
    expect(cron?.schedule).toBe('0 2 * * *')
  })
})
