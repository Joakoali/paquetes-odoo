# Webapp de Paquetería Fase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the fase 1 webapp — recepción, entrega, and duplicate validation — that lets operarios register packages fast and correctly, with Odoo as the sole source of business truth.

**Architecture:** Next.js app on Vercel with its own Neon Postgres for operarios/sessions/caches. Interactive scanning never touches Odoo — sessions are staged locally, validated against a local cache, then confirmed. Confirmation publishes to an Upstash QStash queue (parallelism: 1) that drains through a single webhook worker, which is the only thing that ever calls Odoo, in batched calls per session.

**Tech Stack:** Next.js (App Router) + TypeScript, Drizzle ORM + `@neondatabase/serverless`, Upstash QStash (`@upstash/qstash`), bcryptjs, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-webapp-paqueteria-fase1-design.md`

## Global Constraints

- Never call Odoo's `unlink()` on pickings — always `action_cancel()` (spec §5).
- Odoo allows ≤1 request/second, no parallel calls, globally across all operarios. Enforced by routing every Odoo call through the QStash `odoo-sync` queue configured with `parallelism: 1` — no code path may call the Odoo client outside that worker except the live duplicate-check and pending-deliveries reads, which are single one-off calls, never loops.
- No business logic gets added inside Odoo (Studio automations, server actions) — the Odoo customization budget is ~100 lines/year. All logic lives in this webapp.
- All Odoo writes during development target the Odoo **test** base, never production. The `ODOO_BASE_URL`/`ODOO_API_KEY` env vars point at test until explicitly told otherwise.
- Custom field names on `stock.picking` (barco, recibido por) differ between Odoo prod and test — never hardcode them, always read from env vars (`ODOO_FIELD_BARCO`, `ODOO_FIELD_RECIBIDO_POR`).
- Every scanned tracking number the operario enters must survive a mid-sync failure — nothing is discarded until Odoo confirms it, per spec §5.

## Notes on schema vs. spec

The spec's abstract `sync_queue` table is not a Postgres table here — QStash itself is the queue. `sesiones_escaneo` carries `estado`/`intentos`/`ultimo_error` directly instead. Two tables not named in the spec are added as necessary refinements: `sesion_courier_batches` (one row per courier "tanda" within a recepción session — each becomes one `stock.move`) and `couriers` (admin-managed list of known couriers mapped to Odoo `product.product` ids, same pattern as `almacenes`).

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.env.example`
- Create: `db/client.ts`
- Test: `db/client.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `db` — a Drizzle `NeonHttpDatabase` instance, exported from `db/client.ts` as `export const db: NeonHttpDatabase`

- [ ] **Step 1: Scaffold Next.js + TypeScript project**

```bash
npx create-next-app@latest . --typescript --app --no-tailwind --no-eslint --src-dir=false --import-alias "@/*" --use-npm
npm install drizzle-orm @neondatabase/serverless
npm install -D drizzle-kit vitest @types/node dotenv
```

- [ ] **Step 2: Write `.env.example`**

```bash
DATABASE_URL=postgres://user:pass@host/db?sslmode=require
ODOO_BASE_URL=https://your-test-instance.odoo.com
ODOO_API_KEY=changeme
ODOO_FIELD_BARCO=x_studio_barco_4
ODOO_FIELD_RECIBIDO_POR=x_studio_recibido_por
QSTASH_TOKEN=changeme
QSTASH_CURRENT_SIGNING_KEY=changeme
QSTASH_NEXT_SIGNING_KEY=changeme
QSTASH_QUEUE_NAME=odoo-sync
APP_BASE_URL=http://localhost:3000
SESSION_COOKIE_NAME=paqueteria_session
```

- [ ] **Step 3: Write failing test for `db/client.ts`**

```typescript
// db/client.test.ts
import { describe, it, expect } from 'vitest'
import { db } from './client'

describe('db client', () => {
  it('exports a drizzle db instance with a select method', () => {
    expect(typeof db.select).toBe('function')
  })
})
```

- [ ] **Step 4: Run test, verify it fails**

Run: `npx vitest run db/client.test.ts`
Expected: FAIL — `Cannot find module './client'` or `DATABASE_URL is not set`

- [ ] **Step 5: Implement `db/client.ts`**

```typescript
// db/client.ts
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}

const sql = neon(process.env.DATABASE_URL)
export const db = drizzle(sql, { schema })
```

- [ ] **Step 6: Create empty `db/schema.ts` placeholder so Step 5 compiles**

```typescript
// db/schema.ts
export {}
```

- [ ] **Step 7: Run test, verify it passes**

Run: `DATABASE_URL=postgres://fake npx vitest run db/client.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json next.config.ts vitest.config.ts .env.example db/client.ts db/client.test.ts db/schema.ts
git commit -m "chore: scaffold Next.js project with Drizzle db client"
```

---

### Task 2: Drizzle schema and seed data

**Files:**
- Modify: `db/schema.ts`
- Create: `drizzle.config.ts`, `db/seed.ts`
- Test: `db/schema.test.ts`

**Interfaces:**
- Consumes: `db` from Task 1
- Produces: Drizzle tables — `operarios`, `sesionesAuth`, `almacenes`, `operarioAlmacenes`, `barcosCache`, `couriers`, `sesionesEscaneo`, `sesionCourierBatches`, `sesionItems`, `trackingActivosCache`, `auditLog` — all exported by name from `db/schema.ts`, plus their inferred row types (`Operario`, `Almacen`, `Courier`, `SesionEscaneo`, `SesionCourierBatch`, `SesionItem`) via `export type X = typeof x.$inferSelect`.

- [ ] **Step 1: Write failing test asserting schema exports exist**

```typescript
// db/schema.test.ts
import { describe, it, expect } from 'vitest'
import * as schema from './schema'

describe('schema', () => {
  it('exports all fase 1 tables', () => {
    const expected = [
      'operarios', 'sesionesAuth', 'almacenes', 'operarioAlmacenes',
      'barcosCache', 'couriers', 'sesionesEscaneo', 'sesionCourierBatches',
      'sesionItems', 'trackingActivosCache', 'auditLog',
    ]
    for (const name of expected) {
      expect(schema).toHaveProperty(name)
    }
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run db/schema.test.ts`
Expected: FAIL — schema has no such properties

- [ ] **Step 3: Implement `db/schema.ts`**

```typescript
// db/schema.ts
import {
  pgTable, uuid, text, varchar, boolean, integer, timestamp,
  pgEnum, jsonb, serial, primaryKey, unique,
} from 'drizzle-orm/pg-core'

export const rolEnum = pgEnum('rol', ['operario', 'admin'])
export const tipoSesionEnum = pgEnum('tipo_sesion', ['recepcion', 'entrega'])
export const estadoSesionEnum = pgEnum('estado_sesion', [
  'en_curso', 'confirmada_pendiente_sync', 'sincronizada', 'error',
])
export const estadoItemEnum = pgEnum('estado_item', [
  'ok', 'duplicado', 'sincronizado', 'error',
])

export const operarios = pgTable('operarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: text('nombre').notNull(),
  login: varchar('login', { length: 64 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rol: rolEnum('rol').notNull().default('operario'),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const sesionesAuth = pgTable('sesiones_auth', {
  id: uuid('id').primaryKey().defaultRandom(),
  operarioId: uuid('operario_id').notNull().references(() => operarios.id),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const almacenes = pgTable('almacenes', {
  id: serial('id').primaryKey(),
  prefijo: varchar('prefijo', { length: 16 }).notNull().unique(),
  nombre: text('nombre').notNull(),
  odooPickingTypeId: integer('odoo_picking_type_id'),
})

export const operarioAlmacenes = pgTable('operario_almacenes', {
  operarioId: uuid('operario_id').notNull().references(() => operarios.id),
  almacenId: integer('almacen_id').notNull().references(() => almacenes.id),
}, (t) => ({
  pk: primaryKey({ columns: [t.operarioId, t.almacenId] }),
}))

export const barcosCache = pgTable('barcos_cache', {
  id: serial('id').primaryKey(),
  odooId: integer('odoo_id').notNull().unique(),
  nombre: text('nombre').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const couriers = pgTable('couriers', {
  id: serial('id').primaryKey(),
  nombre: varchar('nombre', { length: 64 }).notNull().unique(),
  odooProductId: integer('odoo_product_id'),
})

export const sesionesEscaneo = pgTable('sesiones_escaneo', {
  id: uuid('id').primaryKey().defaultRandom(),
  operarioId: uuid('operario_id').notNull().references(() => operarios.id),
  almacenId: integer('almacen_id').notNull().references(() => almacenes.id),
  barcoOdooId: integer('barco_odoo_id').notNull(),
  tipo: tipoSesionEnum('tipo').notNull(),
  estado: estadoSesionEnum('estado').notNull().default('en_curso'),
  odooPickingId: integer('odoo_picking_id'),
  odooPickingIds: jsonb('odoo_picking_ids').$type<number[]>(),
  firmaData: text('firma_data'),
  intentos: integer('intentos').notNull().default(0),
  ultimoError: text('ultimo_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at'),
  syncedAt: timestamp('synced_at'),
})

export const sesionCourierBatches = pgTable('sesion_courier_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  sesionId: uuid('sesion_id').notNull().references(() => sesionesEscaneo.id),
  courierId: integer('courier_id').notNull().references(() => couriers.id),
  odooMoveId: integer('odoo_move_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const sesionItems = pgTable('sesion_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  courierBatchId: uuid('courier_batch_id').notNull().references(() => sesionCourierBatches.id),
  trackingNumber: text('tracking_number').notNull(),
  estado: estadoItemEnum('estado').notNull().default('ok'),
  odooLotId: integer('odoo_lot_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  uniqTracking: unique().on(t.courierBatchId, t.trackingNumber),
}))

export const trackingActivosCache = pgTable('tracking_activos_cache', {
  trackingNumber: text('tracking_number').primaryKey(),
  odooPickingId: integer('odoo_picking_id').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  operarioId: uuid('operario_id').references(() => operarios.id),
  accion: text('accion').notNull(),
  detalle: jsonb('detalle'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export type Operario = typeof operarios.$inferSelect
export type Almacen = typeof almacenes.$inferSelect
export type Courier = typeof couriers.$inferSelect
export type SesionEscaneo = typeof sesionesEscaneo.$inferSelect
export type SesionCourierBatch = typeof sesionCourierBatches.$inferSelect
export type SesionItem = typeof sesionItems.$inferSelect
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run db/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Write `drizzle.config.ts` and generate/push migration**

```typescript
// drizzle.config.ts
import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

Run: `npx drizzle-kit push`
Expected: tables created in the Neon database pointed to by `DATABASE_URL`.

- [ ] **Step 6: Write seed script for `almacenes` and `couriers`**

```typescript
// db/seed.ts
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
```

Run: `npx tsx db/seed.ts`
Expected: 7 `almacenes` rows and 13 `couriers` rows inserted, `odoo_picking_type_id`/`odoo_product_id` left null.

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts db/schema.test.ts drizzle.config.ts db/seed.ts db/migrations
git commit -m "feat: add fase 1 Drizzle schema and seed data"
```

---

### Task 3: Odoo low-level client

**Files:**
- Create: `lib/odoo/client.ts`
- Test: `lib/odoo/client.test.ts`

**Interfaces:**
- Consumes: `ODOO_BASE_URL`, `ODOO_API_KEY` env vars
- Produces: `callKw<T>(model: string, method: string, args: unknown[], kwargs?: Record<string, unknown>): Promise<T>`, and `class OdooError extends Error { constructor(public data: unknown) }`

- [ ] **Step 1: Write failing test for success case**

```typescript
// lib/odoo/client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { callKw, OdooError } from './client'

beforeEach(() => {
  process.env.ODOO_BASE_URL = 'https://test.odoo.com'
  process.env.ODOO_API_KEY = 'fake-key'
})

describe('callKw', () => {
  it('posts to the JSON-2 endpoint with bearer auth and returns the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: [{ id: 1, name: 'Test' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await callKw<Array<{ id: number; name: string }>>(
      'project.project', 'search_read', [[]], { fields: ['name'] },
    )

    expect(result).toEqual([{ id: 1, name: 'Test' }])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://test.odoo.com/json/2/project.project/search_read',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fake-key',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ args: [[]], kwargs: { fields: ['name'] } }),
      }),
    )
  })

  it('throws OdooError on an Odoo-shaped error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: { code: 200, message: 'Access denied' } }),
    }))

    await expect(callKw('stock.picking', 'create', [[]])).rejects.toThrow(OdooError)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run lib/odoo/client.test.ts`
Expected: FAIL — `Cannot find module './client'`

- [ ] **Step 3: Implement `lib/odoo/client.ts`**

```typescript
// lib/odoo/client.ts
export class OdooError extends Error {
  constructor(public data: unknown) {
    super(`Odoo call failed: ${JSON.stringify(data)}`)
  }
}

export async function callKw<T>(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  const baseUrl = process.env.ODOO_BASE_URL
  const apiKey = process.env.ODOO_API_KEY
  if (!baseUrl || !apiKey) {
    throw new Error('ODOO_BASE_URL and ODOO_API_KEY must be set')
  }

  const response = await fetch(`${baseUrl}/json/2/${model}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ args, kwargs }),
  })

  const body = await response.json()
  if (!response.ok || body.error) {
    throw new OdooError(body.error ?? body)
  }
  return body.result as T
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run lib/odoo/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/odoo/client.ts lib/odoo/client.test.ts
git commit -m "feat: add Odoo JSON-2 client wrapper"
```

---

### Task 4: Auth core (password, session, guards)

**Files:**
- Create: `lib/auth/password.ts`, `lib/auth/session.ts`, `lib/auth/guards.ts`
- Test: `lib/auth/password.test.ts`, `lib/auth/session.test.ts`, `lib/auth/guards.test.ts`

**Interfaces:**
- Consumes: `db`, `operarios`, `sesionesAuth`, `Operario` from `db/schema.ts`
- Produces:
  - `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, hash: string): Promise<boolean>`
  - `createSession(operarioId: string): Promise<string>` (returns cookie token), `getSessionOperario(token: string): Promise<Operario | null>`, `destroySession(token: string): Promise<void>`
  - `requireOperario(token: string | undefined): Promise<Operario>` (throws `UnauthorizedError`), `requireAdmin(token: string | undefined): Promise<Operario>` (throws `ForbiddenError` if `rol !== 'admin'`)
  - `class UnauthorizedError extends Error {}`, `class ForbiddenError extends Error {}`

- [ ] **Step 1: Write failing test for password hashing**

```typescript
// lib/auth/password.test.ts
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('password', () => {
  it('hashes and verifies correctly', async () => {
    const hash = await hashPassword('correct-horse')
    expect(hash).not.toBe('correct-horse')
    expect(await verifyPassword('correct-horse', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run lib/auth/password.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/auth/password.ts`**

```typescript
// lib/auth/password.ts
import bcrypt from 'bcryptjs'

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}
```

Run: `npm install bcryptjs && npm install -D @types/bcryptjs`

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run lib/auth/password.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for session create/read/destroy**

```typescript
// lib/auth/session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbState = { auth: [] as any[], operarios: [] as any[] }

vi.mock('../../db/client', () => ({
  db: {
    insert: () => ({
      values: (v: any) => {
        const row = { id: 'session-1', ...v }
        dbState.auth.push(row)
        return { returning: async () => [row] }
      },
    }),
    query: {
      sesionesAuth: {
        findFirst: async ({ where }: any) =>
          dbState.auth.find((r) => where(r, { eq: (a: any, b: any) => a === b })) ?? undefined,
      },
    },
    delete: () => ({ where: async () => { dbState.auth = [] } }),
  },
}))

import { createSession, getSessionOperario, destroySession } from './session'

beforeEach(() => {
  dbState.auth = []
  dbState.operarios = [{ id: 'op-1', nombre: 'Juan', login: 'juan', rol: 'operario', activo: true }]
})

describe('session', () => {
  it('creates a session and can be destroyed', async () => {
    const token = await createSession('op-1')
    expect(typeof token).toBe('string')
    await destroySession(token)
    expect(dbState.auth.length).toBe(0)
  })
})
```

*Note: this test's mock is a minimal stand-in — Step 7 (integration) is what actually exercises the real `db` against Neon; this unit test only proves `createSession`/`destroySession` call the expected `db` methods.*

- [ ] **Step 6: Run test, verify it fails**

Run: `npx vitest run lib/auth/session.test.ts`
Expected: FAIL — module not found

- [ ] **Step 7: Implement `lib/auth/session.ts`**

```typescript
// lib/auth/session.ts
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { sesionesAuth, operarios, type Operario } from '../../db/schema'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours

export async function createSession(operarioId: string): Promise<string> {
  const [row] = await db.insert(sesionesAuth).values({
    operarioId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  }).returning()
  return row.id
}

export async function getSessionOperario(token: string): Promise<Operario | null> {
  const session = await db.query.sesionesAuth.findFirst({
    where: eq(sesionesAuth.id, token),
  })
  if (!session || session.expiresAt < new Date()) return null

  const operario = await db.query.operarios.findFirst({
    where: eq(operarios.id, session.operarioId),
  })
  if (!operario || !operario.activo) return null
  return operario
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sesionesAuth).where(eq(sesionesAuth.id, token))
}
```

- [ ] **Step 8: Run test, verify it passes**

Run: `npx vitest run lib/auth/session.test.ts`
Expected: PASS

- [ ] **Step 9: Write failing test for guards**

```typescript
// lib/auth/guards.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('./session', () => ({
  getSessionOperario: vi.fn(),
}))

import { getSessionOperario } from './session'
import { requireOperario, requireAdmin, UnauthorizedError, ForbiddenError } from './guards'

describe('guards', () => {
  it('requireOperario throws UnauthorizedError with no token', async () => {
    await expect(requireOperario(undefined)).rejects.toThrow(UnauthorizedError)
  })

  it('requireOperario returns the operario when session is valid', async () => {
    vi.mocked(getSessionOperario).mockResolvedValue({ id: 'op-1', rol: 'operario' } as any)
    const operario = await requireOperario('token-1')
    expect(operario.id).toBe('op-1')
  })

  it('requireAdmin throws ForbiddenError for a non-admin operario', async () => {
    vi.mocked(getSessionOperario).mockResolvedValue({ id: 'op-1', rol: 'operario' } as any)
    await expect(requireAdmin('token-1')).rejects.toThrow(ForbiddenError)
  })
})
```

- [ ] **Step 10: Run test, verify it fails**

Run: `npx vitest run lib/auth/guards.test.ts`
Expected: FAIL — module not found

- [ ] **Step 11: Implement `lib/auth/guards.ts`**

```typescript
// lib/auth/guards.ts
import { getSessionOperario } from './session'
import type { Operario } from '../../db/schema'

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

export async function requireOperario(token: string | undefined): Promise<Operario> {
  if (!token) throw new UnauthorizedError('No session token')
  const operario = await getSessionOperario(token)
  if (!operario) throw new UnauthorizedError('Invalid or expired session')
  return operario
}

export async function requireAdmin(token: string | undefined): Promise<Operario> {
  const operario = await requireOperario(token)
  if (operario.rol !== 'admin') throw new ForbiddenError('Admin role required')
  return operario
}
```

- [ ] **Step 12: Run test, verify it passes**

Run: `npx vitest run lib/auth/guards.test.ts`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add lib/auth
git commit -m "feat: add auth core (password hashing, sessions, guards)"
```

---

### Task 5: Login page and action

**Files:**
- Create: `app/(auth)/login/page.tsx`, `app/(auth)/login/actions.ts`, `app/(auth)/logout/actions.ts`

**Interfaces:**
- Consumes: `hashPassword`/`verifyPassword` (Task 4), `createSession`/`destroySession` (Task 4), `db`/`operarios` (Task 2)
- Produces: `login(formData: FormData): Promise<{ error: string } | never>` (redirects on success), `logout(): Promise<never>` (redirects to `/login`)

- [ ] **Step 1: Implement `app/(auth)/login/actions.ts`**

```typescript
// app/(auth)/login/actions.ts
'use server'

import { eq } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '../../../db/client'
import { operarios } from '../../../db/schema'
import { verifyPassword } from '../../../lib/auth/password'
import { createSession } from '../../../lib/auth/session'

export async function login(formData: FormData): Promise<{ error: string } | undefined> {
  const login = String(formData.get('login') ?? '')
  const password = String(formData.get('password') ?? '')

  const operario = await db.query.operarios.findFirst({ where: eq(operarios.login, login) })
  if (!operario || !operario.activo || !(await verifyPassword(password, operario.passwordHash))) {
    return { error: 'Usuario o contraseña incorrectos' }
  }

  const token = await createSession(operario.id)
  const cookieStore = await cookies()
  cookieStore.set(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  })
  redirect('/recepcion')
}
```

- [ ] **Step 2: Implement `app/(auth)/logout/actions.ts`**

```typescript
// app/(auth)/logout/actions.ts
'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { destroySession } from '../../../lib/auth/session'

export async function logout(): Promise<void> {
  const cookieStore = await cookies()
  const name = process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session'
  const token = cookieStore.get(name)?.value
  if (token) await destroySession(token)
  cookieStore.delete(name)
  redirect('/login')
}
```

- [ ] **Step 3: Implement `app/(auth)/login/page.tsx`**

```tsx
// app/(auth)/login/page.tsx
import { login } from './actions'

export default function LoginPage() {
  return (
    <form action={async (formData: FormData) => {
      'use server'
      const result = await login(formData)
      if (result?.error) throw new Error(result.error)
    }} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320, margin: '4rem auto' }}>
      <h1>Ingresar</h1>
      <input name="login" placeholder="Usuario" required autoFocus />
      <input name="password" type="password" placeholder="Contraseña" required />
      <button type="submit">Entrar</button>
    </form>
  )
}
```

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, seed one operario via a quick script (`db/seed-operario-dev.ts` calling `hashPassword` and inserting into `operarios` with `rol: 'admin'`), then log in at `http://localhost:3000/login` with that login/password and confirm redirect to `/recepcion` (page not built yet — a 404 there is expected and fine for this task).

- [ ] **Step 5: Commit**

```bash
git add "app/(auth)"
git commit -m "feat: add login/logout pages and actions"
```

---

### Task 6: Admin CRUD for operarios

**Files:**
- Create: `lib/admin/operarios.ts`, `app/admin/operarios/page.tsx`, `app/admin/operarios/actions.ts`
- Test: `lib/admin/operarios.test.ts`

**Interfaces:**
- Consumes: `db`, `operarios`, `hashPassword`, `requireAdmin`
- Produces: `listOperarios(): Promise<Operario[]>`, `createOperario(input: { nombre: string; login: string; password: string; rol: 'operario' | 'admin' }): Promise<Operario>`, `setOperarioActivo(id: string, activo: boolean): Promise<void>`

- [ ] **Step 1: Write failing test**

```typescript
// lib/admin/operarios.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: any[] = []
vi.mock('../../db/client', () => ({
  db: {
    query: { operarios: { findMany: async () => rows } },
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { id: `op-${rows.length + 1}`, activo: true, ...v }
          rows.push(row)
          return [row]
        },
      }),
    }),
    update: () => ({
      set: (v: any) => ({
        where: async () => { Object.assign(rows[0], v) },
      }),
    }),
  },
}))
vi.mock('../auth/password', () => ({ hashPassword: async (p: string) => `hashed:${p}` }))

import { listOperarios, createOperario, setOperarioActivo } from './operarios'

beforeEach(() => { rows.length = 0 })

describe('admin operarios', () => {
  it('creates an operario with a hashed password', async () => {
    const op = await createOperario({ nombre: 'Ana', login: 'ana', password: 'secret', rol: 'operario' })
    expect(op.passwordHash).toBe('hashed:secret')
    expect(await listOperarios()).toHaveLength(1)
  })

  it('toggles activo', async () => {
    await createOperario({ nombre: 'Ana', login: 'ana', password: 'secret', rol: 'operario' })
    await setOperarioActivo('op-1', false)
    expect(rows[0].activo).toBe(false)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run lib/admin/operarios.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/admin/operarios.ts`**

```typescript
// lib/admin/operarios.ts
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { operarios, type Operario } from '../../db/schema'
import { hashPassword } from '../auth/password'

export async function listOperarios(): Promise<Operario[]> {
  return db.query.operarios.findMany()
}

export async function createOperario(input: {
  nombre: string
  login: string
  password: string
  rol: 'operario' | 'admin'
}): Promise<Operario> {
  const passwordHash = await hashPassword(input.password)
  const [row] = await db.insert(operarios).values({
    nombre: input.nombre,
    login: input.login,
    passwordHash,
    rol: input.rol,
  }).returning()
  return row
}

export async function setOperarioActivo(id: string, activo: boolean): Promise<void> {
  await db.update(operarios).set({ activo }).where(eq(operarios.id, id))
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run lib/admin/operarios.test.ts`
Expected: PASS

- [ ] **Step 5: Implement `app/admin/operarios/actions.ts`**

```typescript
// app/admin/operarios/actions.ts
'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '../../../lib/auth/guards'
import { createOperario, setOperarioActivo } from '../../../lib/admin/operarios'

async function currentToken(): Promise<string | undefined> {
  const store = await cookies()
  return store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value
}

export async function createOperarioAction(formData: FormData): Promise<void> {
  await requireAdmin(await currentToken())
  await createOperario({
    nombre: String(formData.get('nombre')),
    login: String(formData.get('login')),
    password: String(formData.get('password')),
    rol: formData.get('rol') === 'admin' ? 'admin' : 'operario',
  })
  revalidatePath('/admin/operarios')
}

export async function toggleOperarioActivoAction(id: string, activo: boolean): Promise<void> {
  await requireAdmin(await currentToken())
  await setOperarioActivo(id, activo)
  revalidatePath('/admin/operarios')
}
```

- [ ] **Step 6: Implement `app/admin/operarios/page.tsx`**

```tsx
// app/admin/operarios/page.tsx
import { listOperarios } from '../../../lib/admin/operarios'
import { createOperarioAction, toggleOperarioActivoAction } from './actions'

export default async function OperariosAdminPage() {
  const operarios = await listOperarios()
  return (
    <main>
      <h1>Operarios</h1>
      <form action={createOperarioAction}>
        <input name="nombre" placeholder="Nombre" required />
        <input name="login" placeholder="Usuario" required />
        <input name="password" type="password" placeholder="Contraseña" required />
        <select name="rol"><option value="operario">Operario</option><option value="admin">Admin</option></select>
        <button type="submit">Crear</button>
      </form>
      <ul>
        {operarios.map((op) => (
          <li key={op.id}>
            {op.nombre} ({op.login}) — {op.rol} — {op.activo ? 'activo' : 'inactivo'}
            <form action={toggleOperarioActivoAction.bind(null, op.id, !op.activo)}>
              <button type="submit">{op.activo ? 'Desactivar' : 'Activar'}</button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

- [ ] **Step 7: Commit**

```bash
git add lib/admin/operarios.ts lib/admin/operarios.test.ts app/admin/operarios
git commit -m "feat: add admin CRUD for operarios"
```

---

### Task 7: Admin UI to assign almacenes to an operario

**Files:**
- Create: `lib/admin/operarioAlmacenes.ts`, `app/admin/operarios/[id]/almacenes/page.tsx`, `app/admin/operarios/[id]/almacenes/actions.ts`
- Test: `lib/admin/operarioAlmacenes.test.ts`

**Interfaces:**
- Consumes: `db`, `almacenes`, `operarioAlmacenes` (Task 2), `requireAdmin` (Task 4)
- Produces: `getAlmacenesForOperario(operarioId: string): Promise<Almacen[]>`, `setAlmacenesForOperario(operarioId: string, almacenIds: number[]): Promise<void>`

- [ ] **Step 1: Write failing test**

```typescript
// lib/admin/operarioAlmacenes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const links: Array<{ operarioId: string; almacenId: number }> = []
const almacenRows = [{ id: 1, prefijo: 'MB92', nombre: 'Barcelona', odooPickingTypeId: null }]

vi.mock('../../db/client', () => ({
  db: {
    query: {
      operarioAlmacenes: {
        findMany: async ({ where }: any) => links.filter((l) => where(l, { eq: (a: any, b: any) => a === b })),
      },
    },
    delete: () => ({ where: async () => { links.length = 0 } }),
    insert: () => ({ values: (rows: any[]) => ({ then: (r: any) => Promise.resolve(links.push(...rows)).then(r) }) }),
    select: () => ({ from: () => ({ where: async () => almacenRows }) }),
  },
}))

import { getAlmacenesForOperario, setAlmacenesForOperario } from './operarioAlmacenes'

beforeEach(() => { links.length = 0 })

describe('operario almacenes', () => {
  it('replaces the set of assigned almacenes', async () => {
    await setAlmacenesForOperario('op-1', [1])
    expect(links).toEqual([{ operarioId: 'op-1', almacenId: 1 }])
    const result = await getAlmacenesForOperario('op-1')
    expect(result).toEqual(almacenRows)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run lib/admin/operarioAlmacenes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/admin/operarioAlmacenes.ts`**

```typescript
// lib/admin/operarioAlmacenes.ts
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, operarioAlmacenes, type Almacen } from '../../db/schema'

export async function getAlmacenesForOperario(operarioId: string): Promise<Almacen[]> {
  const links = await db.query.operarioAlmacenes.findMany({
    where: eq(operarioAlmacenes.operarioId, operarioId),
  })
  if (links.length === 0) return []
  const ids = links.map((l) => l.almacenId)
  return db.select().from(almacenes).where(inArray(almacenes.id, ids))
}

export async function setAlmacenesForOperario(operarioId: string, almacenIds: number[]): Promise<void> {
  await db.delete(operarioAlmacenes).where(eq(operarioAlmacenes.operarioId, operarioId))
  if (almacenIds.length > 0) {
    await db.insert(operarioAlmacenes).values(almacenIds.map((almacenId) => ({ operarioId, almacenId })))
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run lib/admin/operarioAlmacenes.test.ts`
Expected: PASS

- [ ] **Step 5: Implement `app/admin/operarios/[id]/almacenes/actions.ts`**

```typescript
// app/admin/operarios/[id]/almacenes/actions.ts
'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '../../../../../lib/auth/guards'
import { setAlmacenesForOperario } from '../../../../../lib/admin/operarioAlmacenes'

export async function updateAlmacenesAction(operarioId: string, formData: FormData): Promise<void> {
  const store = await cookies()
  await requireAdmin(store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value)
  const almacenIds = formData.getAll('almacenId').map((v) => Number(v))
  await setAlmacenesForOperario(operarioId, almacenIds)
  revalidatePath(`/admin/operarios/${operarioId}/almacenes`)
}
```

- [ ] **Step 6: Implement `app/admin/operarios/[id]/almacenes/page.tsx`**

```tsx
// app/admin/operarios/[id]/almacenes/page.tsx
import { db } from '../../../../../db/client'
import { almacenes } from '../../../../../db/schema'
import { getAlmacenesForOperario } from '../../../../../lib/admin/operarioAlmacenes'
import { updateAlmacenesAction } from './actions'

export default async function OperarioAlmacenesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [all, assigned] = await Promise.all([
    db.select().from(almacenes),
    getAlmacenesForOperario(id),
  ])
  const assignedIds = new Set(assigned.map((a) => a.id))

  return (
    <main>
      <h1>Almacenes asignados</h1>
      <form action={updateAlmacenesAction.bind(null, id)}>
        {all.map((a) => (
          <label key={a.id} style={{ display: 'block' }}>
            <input type="checkbox" name="almacenId" value={a.id} defaultChecked={assignedIds.has(a.id)} />
            {a.prefijo} — {a.nombre}
          </label>
        ))}
        <button type="submit">Guardar</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 7: Commit**

```bash
git add lib/admin/operarioAlmacenes.ts lib/admin/operarioAlmacenes.test.ts "app/admin/operarios/[id]"
git commit -m "feat: add admin UI to assign almacenes per operario"
```

---

### Task 8: Admin UI for Odoo id mappings (almacenes and couriers)

**Files:**
- Create: `lib/admin/odooMappings.ts`, `app/admin/mapeos/page.tsx`, `app/admin/mapeos/actions.ts`
- Test: `lib/admin/odooMappings.test.ts`

**Interfaces:**
- Consumes: `db`, `almacenes`, `couriers` (Task 2), `requireAdmin` (Task 4)
- Produces: `setAlmacenOdooPickingTypeId(almacenId: number, odooPickingTypeId: number): Promise<void>`, `setCourierOdooProductId(courierId: number, odooProductId: number): Promise<void>`

- [ ] **Step 1: Write failing test**

```typescript
// lib/admin/odooMappings.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const almacenRows = [{ id: 1, odooPickingTypeId: null as number | null }]
const courierRows = [{ id: 1, odooProductId: null as number | null }]

vi.mock('../../db/client', () => ({
  db: {
    update: (table: any) => ({
      set: (v: any) => ({
        where: async () => {
          const target = table === 'almacenes' ? almacenRows[0] : courierRows[0]
          Object.assign(target, v)
        },
      }),
    }),
  },
}))
vi.mock('../../db/schema', () => ({ almacenes: 'almacenes', couriers: 'couriers' }))

import { setAlmacenOdooPickingTypeId, setCourierOdooProductId } from './odooMappings'

beforeEach(() => {
  almacenRows[0].odooPickingTypeId = null
  courierRows[0].odooProductId = null
})

describe('odoo mappings', () => {
  it('sets the picking type id for an almacen', async () => {
    await setAlmacenOdooPickingTypeId(1, 42)
    expect(almacenRows[0].odooPickingTypeId).toBe(42)
  })

  it('sets the product id for a courier', async () => {
    await setCourierOdooProductId(1, 99)
    expect(courierRows[0].odooProductId).toBe(99)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run lib/admin/odooMappings.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/admin/odooMappings.ts`**

```typescript
// lib/admin/odooMappings.ts
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { almacenes, couriers } from '../../db/schema'

export async function setAlmacenOdooPickingTypeId(almacenId: number, odooPickingTypeId: number): Promise<void> {
  await db.update(almacenes).set({ odooPickingTypeId }).where(eq(almacenes.id, almacenId))
}

export async function setCourierOdooProductId(courierId: number, odooProductId: number): Promise<void> {
  await db.update(couriers).set({ odooProductId }).where(eq(couriers.id, courierId))
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run lib/admin/odooMappings.test.ts`
Expected: PASS

- [ ] **Step 5: Implement `app/admin/mapeos/actions.ts`**

```typescript
// app/admin/mapeos/actions.ts
'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '../../../lib/auth/guards'
import { setAlmacenOdooPickingTypeId, setCourierOdooProductId } from '../../../lib/admin/odooMappings'

async function currentToken(): Promise<string | undefined> {
  const store = await cookies()
  return store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value
}

export async function updateAlmacenMappingAction(almacenId: number, formData: FormData): Promise<void> {
  await requireAdmin(await currentToken())
  await setAlmacenOdooPickingTypeId(almacenId, Number(formData.get('odooPickingTypeId')))
  revalidatePath('/admin/mapeos')
}

export async function updateCourierMappingAction(courierId: number, formData: FormData): Promise<void> {
  await requireAdmin(await currentToken())
  await setCourierOdooProductId(courierId, Number(formData.get('odooProductId')))
  revalidatePath('/admin/mapeos')
}
```

- [ ] **Step 6: Implement `app/admin/mapeos/page.tsx`**

```tsx
// app/admin/mapeos/page.tsx
import { db } from '../../../db/client'
import { almacenes, couriers } from '../../../db/schema'
import { updateAlmacenMappingAction, updateCourierMappingAction } from './actions'

export default async function MapeosPage() {
  const [allAlmacenes, allCouriers] = await Promise.all([
    db.select().from(almacenes),
    db.select().from(couriers),
  ])

  return (
    <main>
      <h1>Mapeos con Odoo</h1>
      <p>
        Estos IDs deben completarse buscando los valores reales en el Odoo de destino
        antes de que recepción/entrega funcionen contra ese entorno.
      </p>
      <h2>Almacenes → picking_type_id</h2>
      {allAlmacenes.map((a) => (
        <form key={a.id} action={updateAlmacenMappingAction.bind(null, a.id)}>
          {a.prefijo}
          <input name="odooPickingTypeId" type="number" defaultValue={a.odooPickingTypeId ?? ''} required />
          <button type="submit">Guardar</button>
        </form>
      ))}
      <h2>Couriers → product_id</h2>
      {allCouriers.map((c) => (
        <form key={c.id} action={updateCourierMappingAction.bind(null, c.id)}>
          {c.nombre}
          <input name="odooProductId" type="number" defaultValue={c.odooProductId ?? ''} required />
          <button type="submit">Guardar</button>
        </form>
      ))}
    </main>
  )
}
```

- [ ] **Step 7: Commit**

```bash
git add lib/admin/odooMappings.ts lib/admin/odooMappings.test.ts app/admin/mapeos
git commit -m "feat: add admin UI for Odoo id mappings"
```

---

### Task 9: Odoo duplicate-check operation

**Files:**
- Create: `lib/odoo/pickings.ts`
- Test: `lib/odoo/pickings.test.ts`

**Interfaces:**
- Consumes: `callKw` (Task 3)
- Produces: `checkDuplicateTrackingNumbers(trackingNumbers: string[]): Promise<string[]>`

- [ ] **Step 1: Write failing test**

```typescript
// lib/odoo/pickings.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('./client', () => ({ callKw: vi.fn() }))
import { callKw } from './client'
import { checkDuplicateTrackingNumbers } from './pickings'

describe('checkDuplicateTrackingNumbers', () => {
  it('returns the tracking numbers already present in Odoo, via one call', async () => {
    vi.mocked(callKw).mockResolvedValue([
      { lot_id: [10, 'ABC123'] },
      { lot_id: [11, 'XYZ789'] },
    ])

    const result = await checkDuplicateTrackingNumbers(['ABC123', 'DEF456', 'XYZ789'])

    expect(result).toEqual(['ABC123', 'XYZ789'])
    expect(callKw).toHaveBeenCalledTimes(1)
    expect(callKw).toHaveBeenCalledWith(
      'stock.move.line',
      'search_read',
      [[
        ['lot_id.name', 'in', ['ABC123', 'DEF456', 'XYZ789']],
        ['state', '!=', 'cancel'],
      ]],
      { fields: ['lot_id'] },
    )
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run lib/odoo/pickings.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `checkDuplicateTrackingNumbers` in `lib/odoo/pickings.ts`**

```typescript
// lib/odoo/pickings.ts
import { callKw } from './client'

interface MoveLineLotRead {
  lot_id: [number, string] | false
}

export async function checkDuplicateTrackingNumbers(trackingNumbers: string[]): Promise<string[]> {
  if (trackingNumbers.length === 0) return []
  const rows = await callKw<MoveLineLotRead[]>(
    'stock.move.line',
    'search_read',
    [[
      ['lot_id.name', 'in', trackingNumbers],
      ['state', '!=', 'cancel'],
    ]],
    { fields: ['lot_id'] },
  )
  const found = new Set(rows.filter((r) => r.lot_id).map((r) => (r.lot_id as [number, string])[1]))
  return trackingNumbers.filter((t) => found.has(t))
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run lib/odoo/pickings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/odoo/pickings.ts lib/odoo/pickings.test.ts
git commit -m "feat: add Odoo live duplicate tracking number check"
```

---

### Task 10: Odoo picking creation, batch move lines, validation

**Files:**
- Modify: `lib/odoo/pickings.ts`
- Test: Modify `lib/odoo/pickings.test.ts`

**Interfaces:**
- Consumes: `callKw` (Task 3)
- Produces: `createIncomingPicking(almacenPickingTypeId: number, barcoOdooId: number): Promise<number>`, `addCourierMoveWithLines(pickingId: number, courierProductId: number, trackingNumbers: string[]): Promise<number>` (returns the created `stock.move` id), `validatePicking(pickingId: number): Promise<void>`

- [ ] **Step 1: Write failing tests**

```typescript
// append to lib/odoo/pickings.test.ts
import { createIncomingPicking, addCourierMoveWithLines, validatePicking } from './pickings'

describe('createIncomingPicking', () => {
  it('creates a picking with the barco custom field and picking type, in one call', async () => {
    process.env.ODOO_FIELD_BARCO = 'x_studio_barco_4'
    vi.mocked(callKw).mockResolvedValue(501)

    const id = await createIncomingPicking(7, 33)

    expect(id).toBe(501)
    expect(callKw).toHaveBeenCalledTimes(1)
    expect(callKw).toHaveBeenCalledWith('stock.picking', 'create', [{
      picking_type_id: 7,
      x_studio_barco_4: 33,
    }])
  })
})

describe('addCourierMoveWithLines', () => {
  it('creates one move and one batch move.line call for all tracking numbers', async () => {
    vi.mocked(callKw)
      .mockResolvedValueOnce(900) // move create
      .mockResolvedValueOnce([1, 2]) // move.line create (batch)

    const moveId = await addCourierMoveWithLines(501, 15, ['T1', 'T2'])

    expect(moveId).toBe(900)
    expect(callKw).toHaveBeenNthCalledWith(1, 'stock.move', 'create', [{
      picking_id: 501,
      product_id: 15,
      product_uom_qty: 2,
      name: 'Recepción webapp',
    }])
    expect(callKw).toHaveBeenNthCalledWith(2, 'stock.move.line', 'create', [[
      { move_id: 900, picking_id: 501, product_id: 15, lot_name: 'T1', qty_done: 1 },
      { move_id: 900, picking_id: 501, product_id: 15, lot_name: 'T2', qty_done: 1 },
    ]])
  })
})

describe('validatePicking', () => {
  it('runs confirm, assign, and validate in sequence', async () => {
    vi.mocked(callKw).mockResolvedValue(true)

    await validatePicking(501)

    expect(callKw).toHaveBeenNthCalledWith(1, 'stock.picking', 'action_confirm', [[501]])
    expect(callKw).toHaveBeenNthCalledWith(2, 'stock.picking', 'action_assign', [[501]])
    expect(callKw).toHaveBeenNthCalledWith(3, 'stock.picking', 'button_validate', [[501]])
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run lib/odoo/pickings.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement the three functions in `lib/odoo/pickings.ts`**

```typescript
// append to lib/odoo/pickings.ts

export async function createIncomingPicking(almacenPickingTypeId: number, barcoOdooId: number): Promise<number> {
  const barcoField = process.env.ODOO_FIELD_BARCO
  if (!barcoField) throw new Error('ODOO_FIELD_BARCO is not set')

  return callKw<number>('stock.picking', 'create', [{
    picking_type_id: almacenPickingTypeId,
    [barcoField]: barcoOdooId,
  }])
}

export async function addCourierMoveWithLines(
  pickingId: number,
  courierProductId: number,
  trackingNumbers: string[],
): Promise<number> {
  const moveId = await callKw<number>('stock.move', 'create', [{
    picking_id: pickingId,
    product_id: courierProductId,
    product_uom_qty: trackingNumbers.length,
    name: 'Recepción webapp',
  }])

  await callKw<number[]>('stock.move.line', 'create', [
    trackingNumbers.map((lot_name) => ({
      move_id: moveId,
      picking_id: pickingId,
      product_id: courierProductId,
      lot_name,
      qty_done: 1,
    })),
  ])

  return moveId
}

export async function validatePicking(pickingId: number): Promise<void> {
  await callKw('stock.picking', 'action_confirm', [[pickingId]])
  await callKw('stock.picking', 'action_assign', [[pickingId]])
  await callKw('stock.picking', 'button_validate', [[pickingId]])
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/odoo/pickings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/odoo/pickings.ts lib/odoo/pickings.test.ts
git commit -m "feat: add Odoo picking creation, batch move lines, validation"
```

---

### Task 11: Barcos cache

**Files:**
- Create: `lib/cache/barcos.ts`
- Test: `lib/cache/barcos.test.ts`

**Interfaces:**
- Consumes: `callKw` (Task 3), `db`, `barcosCache` (Task 2)
- Produces: `refreshBarcosCache(): Promise<void>`, `searchBarcos(query: string): Promise<Array<{ odooId: number; nombre: string }>>`

- [ ] **Step 1: Write failing test**

```typescript
// lib/cache/barcos.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../odoo/client', () => ({ callKw: vi.fn() }))
const rows: Array<{ odooId: number; nombre: string }> = []
vi.mock('../../db/client', () => ({
  db: {
    insert: () => ({
      values: (v: any[]) => ({
        onConflictDoUpdate: async () => { rows.push(...v) },
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  },
}))

import { callKw } from '../odoo/client'
import { refreshBarcosCache, searchBarcos } from './barcos'

beforeEach(() => { rows.length = 0 })

describe('barcos cache', () => {
  it('refreshBarcosCache upserts from project.project', async () => {
    vi.mocked(callKw).mockResolvedValue([{ id: 1, name: 'MOONSHADOW' }])
    await refreshBarcosCache()
    expect(callKw).toHaveBeenCalledWith('project.project', 'search_read', [[]], { fields: ['name'] })
    expect(rows).toEqual([{ odooId: 1, nombre: 'MOONSHADOW' }])
  })

  it('searchBarcos reads from the local cache', async () => {
    rows.push({ odooId: 1, nombre: 'MOONSHADOW' })
    const result = await searchBarcos('moon')
    expect(result).toEqual(rows)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run lib/cache/barcos.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/cache/barcos.ts`**

```typescript
// lib/cache/barcos.ts
import { ilike } from 'drizzle-orm'
import { callKw } from '../odoo/client'
import { db } from '../../db/client'
import { barcosCache } from '../../db/schema'

interface ProjectRead {
  id: number
  name: string
}

export async function refreshBarcosCache(): Promise<void> {
  const projects = await callKw<ProjectRead[]>('project.project', 'search_read', [[]], { fields: ['name'] })
  if (projects.length === 0) return

  await db.insert(barcosCache)
    .values(projects.map((p) => ({ odooId: p.id, nombre: p.name })))
    .onConflictDoUpdate({
      target: barcosCache.odooId,
      set: { nombre: barcosCache.nombre, updatedAt: new Date() },
    })
}

export async function searchBarcos(query: string): Promise<Array<{ odooId: number; nombre: string }>> {
  return db.select({ odooId: barcosCache.odooId, nombre: barcosCache.nombre })
    .from(barcosCache)
    .where(ilike(barcosCache.nombre, `%${query}%`))
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run lib/cache/barcos.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/cache/barcos.ts lib/cache/barcos.test.ts
git commit -m "feat: add barcos cache refresh and search"
```

---

### Task 12: Tracking activos cache

**Files:**
- Create: `lib/cache/trackingActivos.ts`
- Test: `lib/cache/trackingActivos.test.ts`

**Interfaces:**
- Consumes: `db`, `trackingActivosCache` (Task 2)
- Produces: `isKnownDuplicate(trackingNumber: string): Promise<boolean>`, `recordSyncedTracking(trackingNumber: string, odooPickingId: number): Promise<void>`

- [ ] **Step 1: Write failing test**

```typescript
// lib/cache/trackingActivos.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: Array<{ trackingNumber: string; odooPickingId: number }> = []
vi.mock('../../db/client', () => ({
  db: {
    query: {
      trackingActivosCache: {
        findFirst: async ({ where }: any) =>
          rows.find((r) => where(r, { eq: (a: any, b: any) => a === b })) ?? undefined,
      },
    },
    insert: () => ({
      values: (v: any) => ({
        onConflictDoUpdate: async () => { rows.push(v) },
      }),
    }),
  },
}))

import { isKnownDuplicate, recordSyncedTracking } from './trackingActivos'

beforeEach(() => { rows.length = 0 })

describe('tracking activos cache', () => {
  it('isKnownDuplicate is false when not present', async () => {
    expect(await isKnownDuplicate('ABC')).toBe(false)
  })

  it('recordSyncedTracking then isKnownDuplicate is true', async () => {
    await recordSyncedTracking('ABC', 501)
    expect(await isKnownDuplicate('ABC')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run lib/cache/trackingActivos.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/cache/trackingActivos.ts`**

```typescript
// lib/cache/trackingActivos.ts
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { trackingActivosCache } from '../../db/schema'

export async function isKnownDuplicate(trackingNumber: string): Promise<boolean> {
  const row = await db.query.trackingActivosCache.findFirst({
    where: eq(trackingActivosCache.trackingNumber, trackingNumber),
  })
  return row !== undefined
}

export async function recordSyncedTracking(trackingNumber: string, odooPickingId: number): Promise<void> {
  await db.insert(trackingActivosCache)
    .values({ trackingNumber, odooPickingId })
    .onConflictDoUpdate({
      target: trackingActivosCache.trackingNumber,
      set: { odooPickingId, updatedAt: new Date() },
    })
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run lib/cache/trackingActivos.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/cache/trackingActivos.ts lib/cache/trackingActivos.test.ts
git commit -m "feat: add tracking-activos duplicate cache"
```

---

### Task 13: Recepción server actions

**Files:**
- Create: `app/(app)/recepcion/actions.ts`
- Test: `app/(app)/recepcion/actions.test.ts`

**Interfaces:**
- Consumes: `db`, `sesionesEscaneo`, `sesionCourierBatches`, `sesionItems` (Task 2), `isKnownDuplicate` (Task 12), `requireOperario` (Task 4), `publishSync` (Task 15 — declared here, implemented there)
- Produces: `startSession(almacenId: number, barcoOdooId: number): Promise<string>` (sesionId), `startCourierBatch(sesionId: string, courierId: number): Promise<string>` (batchId), `scanTracking(batchId: string, trackingNumber: string): Promise<{ estado: 'ok' | 'duplicado' }>`, `finishCourierBatch(batchId: string): Promise<void>`, `confirmSession(sesionId: string): Promise<void>`

- [ ] **Step 1: Write failing tests**

```typescript
// app/(app)/recepcion/actions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  sesiones: [] as any[],
  batches: [] as any[],
  items: [] as any[],
}

vi.mock('../../../lib/auth/guards', () => ({
  requireOperario: vi.fn().mockResolvedValue({ id: 'op-1' }),
}))
vi.mock('../../../lib/cache/trackingActivos', () => ({
  isKnownDuplicate: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../../lib/queue/publish', () => ({ publishSync: vi.fn() }))
vi.mock('../../../db/client', () => ({
  db: {
    insert: (table: any) => ({
      values: (v: any) => ({
        returning: async () => {
          const id = `id-${Math.random()}`
          const row = { id, ...v }
          if (table === 'sesiones') state.sesiones.push(row)
          if (table === 'batches') state.batches.push(row)
          if (table === 'items') state.items.push(row)
          return [row]
        },
      }),
    }),
    update: () => ({ set: (v: any) => ({ where: async () => { Object.assign(state.sesiones[0], v) } }) }),
    query: {
      sesionItems: {
        findFirst: async ({ where }: any) =>
          state.items.find((r) => where(r, { eq: (a: any, b: any) => a === b, and: (...c: boolean[]) => c.every(Boolean) })),
      },
    },
  },
}))
vi.mock('../../../db/schema', () => ({
  sesionesEscaneo: 'sesiones', sesionCourierBatches: 'batches', sesionItems: 'items',
}))

import { isKnownDuplicate } from '../../../lib/cache/trackingActivos'
import { publishSync } from '../../../lib/queue/publish'
import { startSession, startCourierBatch, scanTracking, finishCourierBatch, confirmSession } from './actions'

beforeEach(() => {
  state.sesiones.length = 0
  state.batches.length = 0
  state.items.length = 0
  vi.mocked(isKnownDuplicate).mockResolvedValue(false)
})

describe('recepcion actions', () => {
  it('scanTracking marks ok when not a duplicate', async () => {
    const result = await scanTracking('batch-1', 'T1')
    expect(result.estado).toBe('ok')
  })

  it('scanTracking marks duplicado when cache says so', async () => {
    vi.mocked(isKnownDuplicate).mockResolvedValue(true)
    const result = await scanTracking('batch-1', 'T2')
    expect(result.estado).toBe('duplicado')
  })

  it('confirmSession transitions state and publishes to the sync queue', async () => {
    const sesionId = await startSession(1, 33)
    await confirmSession(sesionId)
    expect(state.sesiones[0].estado).toBe('confirmada_pendiente_sync')
    expect(publishSync).toHaveBeenCalledWith({ sesionId })
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run "app/(app)/recepcion/actions.test.ts"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `app/(app)/recepcion/actions.ts`**

```typescript
// app/(app)/recepcion/actions.ts
'use server'

import { and, eq } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { db } from '../../../db/client'
import { sesionesEscaneo, sesionCourierBatches, sesionItems } from '../../../db/schema'
import { requireOperario } from '../../../lib/auth/guards'
import { isKnownDuplicate } from '../../../lib/cache/trackingActivos'
import { publishSync } from '../../../lib/queue/publish'

async function currentOperarioId(): Promise<string> {
  const store = await cookies()
  const token = store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value
  const operario = await requireOperario(token)
  return operario.id
}

export async function startSession(almacenId: number, barcoOdooId: number): Promise<string> {
  const operarioId = await currentOperarioId()
  const [row] = await db.insert(sesionesEscaneo).values({
    operarioId, almacenId, barcoOdooId, tipo: 'recepcion',
  }).returning()
  return row.id
}

export async function startCourierBatch(sesionId: string, courierId: number): Promise<string> {
  const [row] = await db.insert(sesionCourierBatches).values({ sesionId, courierId }).returning()
  return row.id
}

export async function scanTracking(
  batchId: string,
  trackingNumber: string,
): Promise<{ estado: 'ok' | 'duplicado' }> {
  const alreadyInBatch = await db.query.sesionItems.findFirst({
    where: and(eq(sesionItems.courierBatchId, batchId), eq(sesionItems.trackingNumber, trackingNumber)),
  })
  const duplicate = Boolean(alreadyInBatch) || (await isKnownDuplicate(trackingNumber))
  const estado = duplicate ? 'duplicado' : 'ok'

  await db.insert(sesionItems).values({ courierBatchId: batchId, trackingNumber, estado })
  return { estado }
}

export async function finishCourierBatch(_batchId: string): Promise<void> {
  // No state change needed today — batches are implicitly closed by starting
  // a new one or confirming the session. Kept as an explicit action so the
  // UI has a clear point to move focus back to the courier selector.
}

export async function confirmSession(sesionId: string): Promise<void> {
  await db.update(sesionesEscaneo).set({
    estado: 'confirmada_pendiente_sync',
    confirmedAt: new Date(),
  }).where(eq(sesionesEscaneo.id, sesionId))

  await publishSync({ sesionId })
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run "app/(app)/recepcion/actions.test.ts"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/recepcion/actions.ts" "app/(app)/recepcion/actions.test.ts"
git commit -m "feat: add recepcion session server actions"
```

---

### Task 14: Recepción scanning UI

**Files:**
- Create: `app/(app)/recepcion/page.tsx`, `app/(app)/recepcion/ScanClient.tsx`

**Interfaces:**
- Consumes: `startSession`, `startCourierBatch`, `scanTracking`, `finishCourierBatch`, `confirmSession` (Task 13), `getAlmacenesForOperario` (Task 7), `searchBarcos` (Task 11), `db`/`couriers` (Task 2)
- Produces: the `/recepcion` route (no exported functions consumed elsewhere)

- [ ] **Step 1: Implement `app/(app)/recepcion/page.tsx`**

```tsx
// app/(app)/recepcion/page.tsx
import { cookies } from 'next/headers'
import { requireOperario } from '../../../lib/auth/guards'
import { getAlmacenesForOperario } from '../../../lib/admin/operarioAlmacenes'
import { db } from '../../../db/client'
import { couriers } from '../../../db/schema'
import { ScanClient } from './ScanClient'

export default async function RecepcionPage() {
  const store = await cookies()
  const operario = await requireOperario(store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value)
  const [almacenes, allCouriers] = await Promise.all([
    getAlmacenesForOperario(operario.id),
    db.select().from(couriers),
  ])

  return <ScanClient almacenes={almacenes} couriers={allCouriers} />
}
```

- [ ] **Step 2: Implement `app/(app)/recepcion/ScanClient.tsx`**

```tsx
// app/(app)/recepcion/ScanClient.tsx
'use client'

import { useRef, useState } from 'react'
import { startSession, startCourierBatch, scanTracking, finishCourierBatch, confirmSession } from './actions'
import { searchBarcos } from '../../../lib/cache/barcos'

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
    setBarcoOptions(value.length >= 2 ? await searchBarcos(value) : [])
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
```

- [ ] **Step 3: Manual verification**

Run `npm run dev`, log in as a seeded operario with at least one almacén assigned, and exercise the full loop in a browser: pick almacén, search and select a barco (requires `refreshBarcosCache()` to have been run at least once against a real or manually-seeded `barcos_cache` row for this step to show results), pick a courier, scan two tracking numbers by typing + Enter (simulates both a hardware scanner and manual entry), confirm "Listo", pick a second courier and repeat, then "Confirmar sesión" and verify a row appears in `sesiones_escaneo` with `estado = 'confirmada_pendiente_sync'`.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/recepcion/page.tsx" "app/(app)/recepcion/ScanClient.tsx"
git commit -m "feat: add recepcion scanning UI"
```

---

### Task 15: QStash publish and signature verification

**Files:**
- Create: `lib/queue/publish.ts`, `lib/queue/verify.ts`
- Test: `lib/queue/verify.test.ts`

**Interfaces:**
- Consumes: `QSTASH_TOKEN`, `QSTASH_QUEUE_NAME`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `APP_BASE_URL` env vars
- Produces: `publishSync(payload: { sesionId: string }): Promise<void>`, `verifyQstashSignature(signature: string, body: string): Promise<boolean>`

- [ ] **Step 1: Install the QStash SDK**

```bash
npm install @upstash/qstash
```

- [ ] **Step 2: Write failing test for signature verification**

```typescript
// lib/queue/verify.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('@upstash/qstash', () => ({
  Receiver: class {
    verify() {
      return this._shouldFail ? Promise.reject(new Error('bad signature')) : Promise.resolve(true)
    }
    _shouldFail = false
  },
}))

import { verifyQstashSignature } from './verify'

describe('verifyQstashSignature', () => {
  it('returns true for a well-formed call', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'current'
    process.env.QSTASH_NEXT_SIGNING_KEY = 'next'
    const result = await verifyQstashSignature('sig', '{"sesionId":"s1"}')
    expect(result).toBe(true)
  })
})
```

- [ ] **Step 3: Run test, verify it fails**

Run: `npx vitest run lib/queue/verify.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `lib/queue/publish.ts` and `lib/queue/verify.ts`**

```typescript
// lib/queue/publish.ts
import { Client } from '@upstash/qstash'

export async function publishSync(payload: { sesionId: string }): Promise<void> {
  const client = new Client({ token: process.env.QSTASH_TOKEN! })
  const queueName = process.env.QSTASH_QUEUE_NAME ?? 'odoo-sync'
  const queue = client.queue({ queueName })
  await queue.upsert({ parallelism: 1 })
  await queue.enqueueJSON({
    url: `${process.env.APP_BASE_URL}/api/qstash/sync-session`,
    body: payload,
  })
}
```

```typescript
// lib/queue/verify.ts
import { Receiver } from '@upstash/qstash'

export async function verifyQstashSignature(signature: string, body: string): Promise<boolean> {
  const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
  })
  try {
    await receiver.verify({ signature, body })
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `npx vitest run lib/queue/verify.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/queue/publish.ts lib/queue/verify.ts lib/queue/verify.test.ts package.json package-lock.json
git commit -m "feat: add QStash publish and signature verification"
```

---

### Task 16: Sync worker — recepción branch

**Files:**
- Create: `app/api/qstash/sync-session/route.ts`, `lib/sync/recepcion.ts`
- Test: `lib/sync/recepcion.test.ts`

**Interfaces:**
- Consumes: `checkDuplicateTrackingNumbers`, `createIncomingPicking`, `addCourierMoveWithLines`, `validatePicking` (Task 9/10), `callKw` (Task 3), `recordSyncedTracking` (Task 12), `db`/schema tables (Task 2)
- Produces: `syncRecepcionSession(sesionId: string): Promise<void>`

- [ ] **Step 1: Write failing tests covering happy path, live-duplicate-found, and resume-after-partial-failure**

```typescript
// lib/sync/recepcion.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../odoo/pickings', () => ({
  checkDuplicateTrackingNumbers: vi.fn(),
  createIncomingPicking: vi.fn(),
  addCourierMoveWithLines: vi.fn(),
  validatePicking: vi.fn(),
}))
vi.mock('../odoo/client', () => ({ callKw: vi.fn() }))
vi.mock('../cache/trackingActivos', () => ({ recordSyncedTracking: vi.fn() }))

const dbState = {
  sesion: {
    id: 's1', almacenId: 1, barcoOdooId: 33, odooPickingId: null as number | null,
    estado: 'confirmada_pendiente_sync', intentos: 0,
  },
  almacen: { id: 1, odooPickingTypeId: 7 },
  batches: [
    { id: 'b1', sesionId: 's1', courierId: 10, odooMoveId: null as number | null },
    { id: 'b2', sesionId: 's1', courierId: 11, odooMoveId: null as number | null },
  ],
  courierProductIds: { 10: 100, 11: 101 } as Record<number, number>,
  items: [
    { id: 'i1', courierBatchId: 'b1', trackingNumber: 'T1', estado: 'ok' },
    { id: 'i2', courierBatchId: 'b2', trackingNumber: 'T2', estado: 'ok' },
  ],
}

vi.mock('../../db/client', () => ({
  db: {
    query: {
      sesionesEscaneo: { findFirst: async () => dbState.sesion },
      almacenes: { findFirst: async () => dbState.almacen },
      sesionCourierBatches: { findMany: async ({ where }: any) =>
        dbState.batches.filter((b) => where(b, { eq: (a: any, b2: any) => a === b2 })) },
      couriers: { findFirst: async ({ where }: any) => {
        const id = Object.keys(dbState.courierProductIds).find((k) =>
          where({ id: Number(k) }, { eq: (a: any, b2: any) => a === b2 }))
        return id ? { id: Number(id), odooProductId: dbState.courierProductIds[Number(id)] } : undefined
      } },
      sesionItems: { findMany: async ({ where }: any) =>
        dbState.items.filter((i) => where(i, { eq: (a: any, b2: any) => a === b2 })) },
    },
    update: () => ({ set: (v: any) => ({ where: async () => { Object.assign(dbState.sesion, v) } }) }),
    insert: () => ({ values: async () => {} }),
  },
}))

import { checkDuplicateTrackingNumbers, createIncomingPicking, addCourierMoveWithLines, validatePicking } from '../odoo/pickings'
import { callKw } from '../odoo/client'
import { syncRecepcionSession } from './recepcion'

beforeEach(() => {
  dbState.sesion.odooPickingId = null
  dbState.sesion.estado = 'confirmada_pendiente_sync'
  dbState.batches[0].odooMoveId = null
  dbState.batches[1].odooMoveId = null
  vi.mocked(checkDuplicateTrackingNumbers).mockResolvedValue([])
  vi.mocked(createIncomingPicking).mockResolvedValue(501)
  vi.mocked(addCourierMoveWithLines).mockResolvedValue(900)
  vi.mocked(validatePicking).mockResolvedValue(undefined)
  vi.mocked(callKw).mockResolvedValue(undefined)
})

describe('syncRecepcionSession', () => {
  it('creates the picking, adds both courier batches in batch calls, and validates', async () => {
    await syncRecepcionSession('s1')

    expect(createIncomingPicking).toHaveBeenCalledWith(7, 33)
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 100, ['T1'])
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 101, ['T2'])
    expect(validatePicking).toHaveBeenCalledWith(501)
    expect(dbState.sesion.estado).toBe('sincronizada')
  })

  it('does not re-create the picking on retry (idempotent)', async () => {
    dbState.sesion.odooPickingId = 501
    await syncRecepcionSession('s1')
    expect(createIncomingPicking).not.toHaveBeenCalled()
  })

  it('skips a batch that already has an odoo_move_id on retry', async () => {
    dbState.sesion.odooPickingId = 501
    dbState.batches[0].odooMoveId = 900
    await syncRecepcionSession('s1')
    expect(addCourierMoveWithLines).toHaveBeenCalledTimes(1)
    expect(addCourierMoveWithLines).toHaveBeenCalledWith(501, 101, ['T2'])
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run lib/sync/recepcion.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/sync/recepcion.ts`**

Behavior for a live duplicate found on the final safety check: mark that item `duplicado` locally, exclude it from the move-line batch for its courier, and continue syncing the rest of the session — a duplicate on one tracking number must not block the other legitimate packages in the same session from being registered.

```typescript
// lib/sync/recepcion.ts
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { sesionesEscaneo, almacenes, sesionCourierBatches, couriers, sesionItems } from '../../db/schema'
import {
  checkDuplicateTrackingNumbers,
  createIncomingPicking,
  addCourierMoveWithLines,
  validatePicking,
} from '../odoo/pickings'
import { callKw } from '../odoo/client'
import { recordSyncedTracking } from '../cache/trackingActivos'

export async function syncRecepcionSession(sesionId: string): Promise<void> {
  const sesion = await db.query.sesionesEscaneo.findFirst({ where: eq(sesionesEscaneo.id, sesionId) })
  if (!sesion) throw new Error(`Sesión ${sesionId} no encontrada`)

  const almacen = await db.query.almacenes.findFirst({ where: eq(almacenes.id, sesion.almacenId) })
  if (!almacen?.odooPickingTypeId) {
    throw new Error(`Almacén ${sesion.almacenId} no tiene odoo_picking_type_id configurado`)
  }

  const batches = await db.query.sesionCourierBatches.findMany({
    where: eq(sesionCourierBatches.sesionId, sesionId),
  })

  let pickingId = sesion.odooPickingId
  if (!pickingId) {
    pickingId = await createIncomingPicking(almacen.odooPickingTypeId, sesion.barcoOdooId)
    await db.update(sesionesEscaneo).set({ odooPickingId: pickingId }).where(eq(sesionesEscaneo.id, sesionId))
  }

  for (const batch of batches) {
    if (batch.odooMoveId) continue // already synced on a previous attempt

    const courier = await db.query.couriers.findFirst({ where: eq(couriers.id, batch.courierId) })
    if (!courier?.odooProductId) {
      throw new Error(`Courier ${batch.courierId} no tiene odoo_product_id configurado`)
    }

    const items = await db.query.sesionItems.findMany({
      where: eq(sesionItems.courierBatchId, batch.id),
    })
    const trackingNumbers = items.map((i) => i.trackingNumber)

    const liveDuplicates = await checkDuplicateTrackingNumbers(trackingNumbers)
    const toSync = trackingNumbers.filter((t) => !liveDuplicates.includes(t))

    for (const tracking of liveDuplicates) {
      await db.update(sesionItems).set({ estado: 'duplicado' })
        .where(eq(sesionItems.trackingNumber, tracking))
    }

    if (toSync.length > 0) {
      const moveId = await addCourierMoveWithLines(pickingId, courier.odooProductId, toSync)
      await db.update(sesionCourierBatches).set({ odooMoveId: moveId }).where(eq(sesionCourierBatches.id, batch.id))
      for (const tracking of toSync) {
        await db.update(sesionItems).set({ estado: 'sincronizado' })
          .where(eq(sesionItems.trackingNumber, tracking))
        await recordSyncedTracking(tracking, pickingId)
      }
    }
  }

  await validatePicking(pickingId)

  const recibidoPorField = process.env.ODOO_FIELD_RECIBIDO_POR
  await callKw('stock.picking', 'message_post', [[pickingId]], {
    body: `Registrado vía Webapp Paquetería por operario ${sesion.operarioId}`,
  })
  if (recibidoPorField) {
    await callKw('stock.picking', 'write', [[pickingId], { [recibidoPorField]: sesion.operarioId }])
  }

  await db.update(sesionesEscaneo).set({
    estado: 'sincronizada',
    syncedAt: new Date(),
  }).where(eq(sesionesEscaneo.id, sesionId))
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/sync/recepcion.test.ts`
Expected: PASS

- [ ] **Step 5: Implement `app/api/qstash/sync-session/route.ts` (recepción branch only — extended in Task 20)**

```typescript
// app/api/qstash/sync-session/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { verifyQstashSignature } from '../../../../lib/queue/verify'
import { db } from '../../../../db/client'
import { sesionesEscaneo } from '../../../../db/schema'
import { syncRecepcionSession } from '../../../../lib/sync/recepcion'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text()
  const signature = request.headers.get('upstash-signature') ?? ''
  if (!(await verifyQstashSignature(signature, body))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  const { sesionId } = JSON.parse(body) as { sesionId: string }
  const sesion = await db.query.sesionesEscaneo.findFirst({ where: eq(sesionesEscaneo.id, sesionId) })
  if (!sesion) return NextResponse.json({ error: 'sesion not found' }, { status: 404 })

  try {
    if (sesion.tipo === 'recepcion') {
      await syncRecepcionSession(sesionId)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.update(sesionesEscaneo).set({
      estado: 'error',
      intentos: sesion.intentos + 1,
      ultimoError: message,
    }).where(eq(sesionesEscaneo.id, sesionId))
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/sync/recepcion.ts lib/sync/recepcion.test.ts app/api/qstash/sync-session/route.ts
git commit -m "feat: add sync worker for recepcion sessions"
```

---

### Task 17: Odoo pending-deliveries read

**Files:**
- Modify: `lib/odoo/pickings.ts`
- Test: Modify `lib/odoo/pickings.test.ts`

**Interfaces:**
- Consumes: `callKw` (Task 3), `ODOO_FIELD_BARCO` env var
- Produces: `interface PendingDelivery { id: number; name: string; trackingNumbers: string[] }`, `getPendingOutgoing(almacenPickingTypeId: number, barcoOdooId: number): Promise<PendingDelivery[]>`

- [ ] **Step 1: Write failing test**

```typescript
// append to lib/odoo/pickings.test.ts
import { getPendingOutgoing } from './pickings'

describe('getPendingOutgoing', () => {
  it('reads outgoing pickings for a barco+almacen with their tracking numbers', async () => {
    process.env.ODOO_FIELD_BARCO = 'x_studio_barco_4'
    vi.mocked(callKw).mockResolvedValue([
      {
        id: 700,
        name: 'MB92/OUT/00069',
        move_line_ids: [{ lot_id: [1, 'T1'] }, { lot_id: [2, 'T2'] }],
      },
    ])

    const result = await getPendingOutgoing(7, 33)

    expect(callKw).toHaveBeenCalledWith(
      'stock.picking',
      'search_read',
      [[
        ['picking_type_id', '=', 7],
        ['x_studio_barco_4', '=', 33],
        ['state', 'not in', ['draft', 'done', 'cancel']],
        ['picking_type_code', '=', 'outgoing'],
      ]],
      { fields: ['name', 'move_line_ids'] },
    )
    expect(result).toEqual([
      { id: 700, name: 'MB92/OUT/00069', trackingNumbers: ['T1', 'T2'] },
    ])
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run lib/odoo/pickings.test.ts`
Expected: FAIL — `getPendingOutgoing` not exported

- [ ] **Step 3: Implement `getPendingOutgoing` in `lib/odoo/pickings.ts`**

Note: this task also needs a way to read a move line's parent picking without a separate query — Odoo's `search_read` on `stock.picking` cannot expand `move_line_ids.lot_id` in one call directly as nested fields the way the test mock implies for simplicity; the real implementation issues one `search_read` on `stock.picking` for the picking ids/names, then one `search_read` on `stock.move.line` filtered by `picking_id in [...]` for the tracking numbers — still two calls total, not per-picking.

```typescript
// append to lib/odoo/pickings.ts

export interface PendingDelivery {
  id: number
  name: string
  trackingNumbers: string[]
}

interface PickingRead {
  id: number
  name: string
}

export async function getPendingOutgoing(almacenPickingTypeId: number, barcoOdooId: number): Promise<PendingDelivery[]> {
  const barcoField = process.env.ODOO_FIELD_BARCO
  if (!barcoField) throw new Error('ODOO_FIELD_BARCO is not set')

  const pickings = await callKw<PickingRead[]>('stock.picking', 'search_read', [[
    ['picking_type_id', '=', almacenPickingTypeId],
    [barcoField, '=', barcoOdooId],
    ['state', 'not in', ['draft', 'done', 'cancel']],
    ['picking_type_code', '=', 'outgoing'],
  ]], { fields: ['name'] })

  if (pickings.length === 0) return []

  const lines = await callKw<Array<{ picking_id: [number, string]; lot_id: [number, string] | false }>>(
    'stock.move.line',
    'search_read',
    [[['picking_id', 'in', pickings.map((p) => p.id)]]],
    { fields: ['picking_id', 'lot_id'] },
  )

  return pickings.map((p) => ({
    id: p.id,
    name: p.name,
    trackingNumbers: lines
      .filter((l) => l.picking_id[0] === p.id && l.lot_id)
      .map((l) => (l.lot_id as [number, string])[1]),
  }))
}
```

- [ ] **Step 4: Update the test to match the real two-call shape**

Replace the test body from Step 1 with:

```typescript
// replace the getPendingOutgoing test in lib/odoo/pickings.test.ts
describe('getPendingOutgoing', () => {
  it('reads outgoing pickings for a barco+almacen with their tracking numbers', async () => {
    process.env.ODOO_FIELD_BARCO = 'x_studio_barco_4'
    vi.mocked(callKw)
      .mockResolvedValueOnce([{ id: 700, name: 'MB92/OUT/00069' }])
      .mockResolvedValueOnce([
        { picking_id: [700, 'MB92/OUT/00069'], lot_id: [1, 'T1'] },
        { picking_id: [700, 'MB92/OUT/00069'], lot_id: [2, 'T2'] },
      ])

    const result = await getPendingOutgoing(7, 33)

    expect(result).toEqual([{ id: 700, name: 'MB92/OUT/00069', trackingNumbers: ['T1', 'T2'] }])
    expect(callKw).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 5: Run test, verify it passes**

Run: `npx vitest run lib/odoo/pickings.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/odoo/pickings.ts lib/odoo/pickings.test.ts
git commit -m "feat: add Odoo pending-outgoing-deliveries read"
```

---

### Task 18: Entrega server actions

**Files:**
- Create: `app/(app)/entrega/actions.ts`
- Test: `app/(app)/entrega/actions.test.ts`

**Interfaces:**
- Consumes: `getPendingOutgoing` (Task 17), `db`/`almacenes` (Task 2), `sesionesEscaneo` (Task 2), `requireOperario` (Task 4), `publishSync` (Task 15)
- Produces: `loadPendingDeliveries(almacenId: number, barcoOdooId: number): Promise<PendingDelivery[]>`, `confirmEntregaSession(almacenId: number, barcoOdooId: number, selectedPickingIds: number[], firmaDataBase64: string): Promise<string>` (sesionId)

- [ ] **Step 1: Write failing tests**

```typescript
// app/(app)/entrega/actions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/auth/guards', () => ({ requireOperario: vi.fn().mockResolvedValue({ id: 'op-1' }) }))
vi.mock('../../../lib/odoo/pickings', () => ({ getPendingOutgoing: vi.fn() }))
vi.mock('../../../lib/queue/publish', () => ({ publishSync: vi.fn() }))

const state = { almacen: { id: 1, odooPickingTypeId: 7 }, sesiones: [] as any[] }
vi.mock('../../../db/client', () => ({
  db: {
    query: { almacenes: { findFirst: async () => state.almacen } },
    insert: () => ({
      values: (v: any) => ({
        returning: async () => { const row = { id: 's1', ...v }; state.sesiones.push(row); return [row] },
      }),
    }),
  },
}))

import { getPendingOutgoing } from '../../../lib/odoo/pickings'
import { publishSync } from '../../../lib/queue/publish'
import { loadPendingDeliveries, confirmEntregaSession } from './actions'

beforeEach(() => { state.sesiones.length = 0 })

describe('entrega actions', () => {
  it('loadPendingDeliveries reads via the almacen picking_type_id', async () => {
    vi.mocked(getPendingOutgoing).mockResolvedValue([{ id: 700, name: 'X', trackingNumbers: ['T1'] }])
    const result = await loadPendingDeliveries(1, 33)
    expect(getPendingOutgoing).toHaveBeenCalledWith(7, 33)
    expect(result).toHaveLength(1)
  })

  it('confirmEntregaSession creates a sesion and publishes to sync', async () => {
    const id = await confirmEntregaSession(1, 33, [700], 'data:image/png;base64,AAA')
    expect(id).toBe('s1')
    expect(state.sesiones[0]).toMatchObject({
      tipo: 'entrega', odooPickingIds: [700], firmaData: 'data:image/png;base64,AAA',
      estado: 'confirmada_pendiente_sync',
    })
    expect(publishSync).toHaveBeenCalledWith({ sesionId: 's1' })
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run "app/(app)/entrega/actions.test.ts"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `app/(app)/entrega/actions.ts`**

```typescript
// app/(app)/entrega/actions.ts
'use server'

import { eq } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { db } from '../../../db/client'
import { almacenes, sesionesEscaneo } from '../../../db/schema'
import { requireOperario } from '../../../lib/auth/guards'
import { getPendingOutgoing, type PendingDelivery } from '../../../lib/odoo/pickings'
import { publishSync } from '../../../lib/queue/publish'

async function currentOperarioId(): Promise<string> {
  const store = await cookies()
  const operario = await requireOperario(store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value)
  return operario.id
}

export async function loadPendingDeliveries(almacenId: number, barcoOdooId: number): Promise<PendingDelivery[]> {
  const almacen = await db.query.almacenes.findFirst({ where: eq(almacenes.id, almacenId) })
  if (!almacen?.odooPickingTypeId) throw new Error(`Almacén ${almacenId} no tiene odoo_picking_type_id configurado`)
  return getPendingOutgoing(almacen.odooPickingTypeId, barcoOdooId)
}

export async function confirmEntregaSession(
  almacenId: number,
  barcoOdooId: number,
  selectedPickingIds: number[],
  firmaDataBase64: string,
): Promise<string> {
  const operarioId = await currentOperarioId()
  const [row] = await db.insert(sesionesEscaneo).values({
    operarioId,
    almacenId,
    barcoOdooId,
    tipo: 'entrega',
    estado: 'confirmada_pendiente_sync',
    odooPickingIds: selectedPickingIds,
    firmaData: firmaDataBase64,
    confirmedAt: new Date(),
  }).returning()

  await publishSync({ sesionId: row.id })
  return row.id
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run "app/(app)/entrega/actions.test.ts"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/entrega/actions.ts" "app/(app)/entrega/actions.test.ts"
git commit -m "feat: add entrega session server actions"
```

---

### Task 19: Entrega UI with signature capture

**Files:**
- Create: `app/(app)/entrega/page.tsx`, `app/(app)/entrega/EntregaClient.tsx`, `app/(app)/entrega/SignaturePad.tsx`

**Interfaces:**
- Consumes: `loadPendingDeliveries`, `confirmEntregaSession` (Task 18), `getAlmacenesForOperario` (Task 7), `searchBarcos` (Task 11)
- Produces: the `/entrega` route

- [ ] **Step 1: Implement `app/(app)/entrega/SignaturePad.tsx`**

```tsx
// app/(app)/entrega/SignaturePad.tsx
'use client'

import { useRef, useState } from 'react'

export function SignaturePad({ onChange }: { onChange: (base64: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drawing, setDrawing] = useState(false)

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    setDrawing(true)
    const ctx = canvasRef.current!.getContext('2d')!
    const { x, y } = pos(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return
    const ctx = canvasRef.current!.getContext('2d')!
    const { x, y } = pos(e)
    ctx.lineTo(x, y)
    ctx.stroke()
  }

  function handlePointerUp() {
    setDrawing(false)
    onChange(canvasRef.current!.toDataURL('image/png'))
  }

  return (
    <canvas
      ref={canvasRef}
      width={400}
      height={200}
      style={{ border: '1px solid #ccc', touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  )
}
```

- [ ] **Step 2: Implement `app/(app)/entrega/EntregaClient.tsx`**

```tsx
// app/(app)/entrega/EntregaClient.tsx
'use client'

import { useState } from 'react'
import { loadPendingDeliveries, confirmEntregaSession } from './actions'
import { searchBarcos } from '../../../lib/cache/barcos'
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
    setBarcoOptions(value.length >= 2 ? await searchBarcos(value) : [])
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
```

- [ ] **Step 3: Implement `app/(app)/entrega/page.tsx`**

```tsx
// app/(app)/entrega/page.tsx
import { cookies } from 'next/headers'
import { requireOperario } from '../../../lib/auth/guards'
import { getAlmacenesForOperario } from '../../../lib/admin/operarioAlmacenes'
import { EntregaClient } from './EntregaClient'

export default async function EntregaPage() {
  const store = await cookies()
  const operario = await requireOperario(store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value)
  const almacenes = await getAlmacenesForOperario(operario.id)
  return <EntregaClient almacenes={almacenes} />
}
```

- [ ] **Step 4: Manual verification**

With at least one real pending outgoing picking in Odoo's test base for a seeded barco, log in, go to `/entrega`, select almacén and barco, confirm the pending deliveries list matches Odoo, draw a signature on the canvas (mouse or touch), confirm, and verify a `sesiones_escaneo` row with `tipo = 'entrega'` and a non-null `firma_data` was created.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/entrega"
git commit -m "feat: add entrega UI with signature capture"
```

---

### Task 20: Sync worker — entrega branch

**Files:**
- Create: `lib/sync/entrega.ts`
- Modify: `app/api/qstash/sync-session/route.ts`
- Test: `lib/sync/entrega.test.ts`

**Interfaces:**
- Consumes: `callKw` (Task 3), `validatePicking` (Task 10), `db`/`sesionesEscaneo` (Task 2), `ODOO_FIELD_RECIBIDO_POR` env var
- Produces: `syncEntregaSession(sesionId: string): Promise<void>`

- [ ] **Step 1: Write failing tests covering happy path and idempotent skip of an already-done picking**

```typescript
// lib/sync/entrega.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../odoo/client', () => ({ callKw: vi.fn() }))
vi.mock('../odoo/pickings', () => ({ validatePicking: vi.fn() }))

const dbState = {
  sesion: {
    id: 's1', odooPickingIds: [700, 701] as number[], firmaData: 'data:image/png;base64,AAA',
    estado: 'confirmada_pendiente_sync', intentos: 0,
  },
}

vi.mock('../../db/client', () => ({
  db: {
    query: { sesionesEscaneo: { findFirst: async () => dbState.sesion } },
    update: () => ({ set: (v: any) => ({ where: async () => { Object.assign(dbState.sesion, v) } }) }),
    insert: () => ({ values: async () => {} }),
  },
}))

import { callKw } from '../odoo/client'
import { validatePicking } from '../odoo/pickings'
import { syncEntregaSession } from './entrega'

beforeEach(() => {
  dbState.sesion.estado = 'confirmada_pendiente_sync'
  vi.mocked(validatePicking).mockResolvedValue(undefined)
})

describe('syncEntregaSession', () => {
  it('writes signature and validates each picking not already done', async () => {
    vi.mocked(callKw).mockImplementation(async (model: string, method: string) => {
      if (model === 'stock.picking' && method === 'read') return [{ id: 700, state: 'assigned' }]
      return undefined
    })

    await syncEntregaSession('s1')

    expect(callKw).toHaveBeenCalledWith('stock.picking', 'write', [[700], {
      signature: 'data:image/png;base64,AAA', is_signed: true,
    }])
    expect(validatePicking).toHaveBeenCalledWith(700)
    expect(dbState.sesion.estado).toBe('sincronizada')
  })

  it('skips a picking already in state done', async () => {
    vi.mocked(callKw).mockImplementation(async (model: string, method: string, args: any[]) => {
      if (model === 'stock.picking' && method === 'read') {
        const id = args[0][0]
        return [{ id, state: id === 700 ? 'done' : 'assigned' }]
      }
      return undefined
    })

    await syncEntregaSession('s1')

    expect(validatePicking).not.toHaveBeenCalledWith(700)
    expect(validatePicking).toHaveBeenCalledWith(701)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run lib/sync/entrega.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/sync/entrega.ts`**

```typescript
// lib/sync/entrega.ts
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { sesionesEscaneo } from '../../db/schema'
import { callKw } from '../odoo/client'
import { validatePicking } from '../odoo/pickings'

export async function syncEntregaSession(sesionId: string): Promise<void> {
  const sesion = await db.query.sesionesEscaneo.findFirst({ where: eq(sesionesEscaneo.id, sesionId) })
  if (!sesion) throw new Error(`Sesión ${sesionId} no encontrada`)
  if (!sesion.odooPickingIds || !sesion.firmaData) {
    throw new Error(`Sesión ${sesionId} no tiene picking ids o firma`)
  }

  for (const pickingId of sesion.odooPickingIds) {
    const [current] = await callKw<Array<{ id: number; state: string }>>(
      'stock.picking', 'read', [[pickingId]], { fields: ['state'] },
    )
    if (current.state === 'done') continue

    await callKw('stock.picking', 'write', [[pickingId], {
      signature: sesion.firmaData,
      is_signed: true,
    }])
    await validatePicking(pickingId)
    await callKw('stock.picking', 'message_post', [[pickingId]], {
      body: `Entrega confirmada vía Webapp Paquetería por operario ${sesion.operarioId}`,
    })
  }

  await db.update(sesionesEscaneo).set({
    estado: 'sincronizada',
    syncedAt: new Date(),
  }).where(eq(sesionesEscaneo.id, sesionId))
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run lib/sync/entrega.test.ts`
Expected: PASS

- [ ] **Step 5: Extend `app/api/qstash/sync-session/route.ts` with the entrega branch**

```typescript
// app/api/qstash/sync-session/route.ts
// Replace the try block's body with:
  try {
    if (sesion.tipo === 'recepcion') {
      await syncRecepcionSession(sesionId)
    } else {
      await syncEntregaSession(sesionId)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
```

Add the import at the top: `import { syncEntregaSession } from '../../../../lib/sync/entrega'`

- [ ] **Step 6: Commit**

```bash
git add lib/sync/entrega.ts lib/sync/entrega.test.ts app/api/qstash/sync-session/route.ts
git commit -m "feat: add sync worker for entrega sessions"
```

---

### Task 21: Pendientes de atención view and manual retry

**Files:**
- Create: `lib/sync/pendientes.ts`, `app/(app)/pendientes/page.tsx`, `app/(app)/pendientes/actions.ts`
- Test: `lib/sync/pendientes.test.ts`

**Interfaces:**
- Consumes: `db`/`sesionesEscaneo` (Task 2), `publishSync` (Task 15), `requireOperario` (Task 4)
- Produces: `listSessionsInError(): Promise<SesionEscaneo[]>`, `retrySession(sesionId: string): Promise<void>`

- [ ] **Step 1: Write failing test**

```typescript
// lib/sync/pendientes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../queue/publish', () => ({ publishSync: vi.fn() }))
const rows = [{ id: 's1', estado: 'error', ultimoError: 'timeout', intentos: 2 }]
vi.mock('../../db/client', () => ({
  db: {
    query: { sesionesEscaneo: { findMany: async () => rows } },
  },
}))

import { publishSync } from '../queue/publish'
import { listSessionsInError, retrySession } from './pendientes'

describe('pendientes', () => {
  it('lists sessions in error state', async () => {
    const result = await listSessionsInError()
    expect(result).toEqual(rows)
  })

  it('retrySession republishes to the sync queue', async () => {
    await retrySession('s1')
    expect(publishSync).toHaveBeenCalledWith({ sesionId: 's1' })
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run lib/sync/pendientes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/sync/pendientes.ts`**

```typescript
// lib/sync/pendientes.ts
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { sesionesEscaneo, type SesionEscaneo } from '../../db/schema'
import { publishSync } from '../queue/publish'

export async function listSessionsInError(): Promise<SesionEscaneo[]> {
  return db.query.sesionesEscaneo.findMany({ where: eq(sesionesEscaneo.estado, 'error') })
}

export async function retrySession(sesionId: string): Promise<void> {
  await publishSync({ sesionId })
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run lib/sync/pendientes.test.ts`
Expected: PASS

- [ ] **Step 5: Implement `app/(app)/pendientes/actions.ts`**

```typescript
// app/(app)/pendientes/actions.ts
'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireOperario } from '../../../lib/auth/guards'
import { retrySession } from '../../../lib/sync/pendientes'

export async function retrySessionAction(sesionId: string): Promise<void> {
  const store = await cookies()
  await requireOperario(store.get(process.env.SESSION_COOKIE_NAME ?? 'paqueteria_session')?.value)
  await retrySession(sesionId)
  revalidatePath('/pendientes')
}
```

- [ ] **Step 6: Implement `app/(app)/pendientes/page.tsx`**

```tsx
// app/(app)/pendientes/page.tsx
import { listSessionsInError } from '../../../lib/sync/pendientes'
import { retrySessionAction } from './actions'

export default async function PendientesPage() {
  const sesiones = await listSessionsInError()
  return (
    <main>
      <h1>Pendientes de atención</h1>
      <ul>
        {sesiones.map((s) => (
          <li key={s.id}>
            Sesión {s.id} — intentos: {s.intentos} — error: {s.ultimoError}
            <form action={retrySessionAction.bind(null, s.id)}>
              <button type="submit">Reintentar</button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

- [ ] **Step 7: Commit**

```bash
git add lib/sync/pendientes.ts lib/sync/pendientes.test.ts "app/(app)/pendientes"
git commit -m "feat: add pendientes de atencion view with manual retry"
```

---

### Task 22: Manual verification checklist (Odoo test base, real devices)

**Files:** none (no code changes)

- [ ] **Step 1: Fill in the Odoo id mappings for real**

In `/admin/mapeos`, look up and enter the real `picking_type_id` for each almacén and the real `product_id` for each courier, in Odoo's **test** base (never production). Confirm `ODOO_BASE_URL`/`ODOO_API_KEY` in the deployment's env point at the test base.

- [ ] **Step 2: Run `refreshBarcosCache()` once**

Trigger it manually (temporary script or an admin button, whichever exists at this point) so `/recepcion` and `/entrega`'s barco search returns real results.

- [ ] **Step 3: Full recepción cycle with a hardware barcode scanner**

Connect a USB/Bluetooth barcode scanner to a device running the webapp. On `/recepcion`, confirm the scanner's keystroke-then-Enter behavior correctly populates the scan input and adds items without any extra clicks. Scan at least 3 real or test tracking numbers across 2 couriers, confirm the session, and verify in Odoo test that a new incoming `stock.picking` was created with both `stock.move`s and all `stock.move.line`s carrying the right `lot_name`s.

- [ ] **Step 4: Full recepción cycle with camera scanning**

Repeat Step 3 on a phone/tablet browser using the camera to scan a QR/barcode into the same focused input (camera-scanning apps that type-and-Enter into the focused field require no special code — confirm this is in fact true on the actual device).

- [ ] **Step 5: Duplicate detection end to end**

Re-scan one of the tracking numbers from Step 3 in a new session for the same barco. Confirm it's flagged `duplicado` in the UI before confirming. Separately, manually create a `stock.move.line` with a fresh tracking number directly in Odoo's test base (bypassing the webapp), then try to scan that same tracking number in the webapp — confirm the live final check at confirm time catches it even though it's not in `tracking_activos_cache` yet.

- [ ] **Step 6: Verify the existing production cron still merges correctly**

After Step 3's picking validates and generates an outgoing delivery, confirm (in Odoo test, with the cron logic from `CONTEXTO-ODOO-WEBAPP.md` §6 replicated or already present there) that the outgoing picking gets the barco field populated and merges with any other pending outgoing for the same barco+almacén, exactly as it does for pickings created through Odoo's own UI.

- [ ] **Step 7: Full entrega cycle with signature**

On `/entrega`, select the barco from Step 3, confirm the pending delivery appears with the right tracking numbers, draw a signature, confirm. Verify in Odoo test that `signature`/`is_signed` were written and the picking is `done`.

- [ ] **Step 8: Error path**

Temporarily set `ODOO_API_KEY` to an invalid value, confirm a new recepción session, confirm it lands in `/pendientes` with `estado = 'error'` and a message. Restore the key, click "Reintentar", confirm it syncs successfully without creating a duplicate picking (idempotency check from Task 16).

---

## Self-Review

**Spec coverage:**
- §1 scope (recepción, entrega, validación, admin mínimo) → Tasks 6-8, 13-14, 17-19.
- §2 architecture (single-consumer queue, service Odoo user, no direct browser→Odoo) → Tasks 3, 15, 16/20 (all Odoo calls gated behind server-only modules and the QStash worker).
- §3 data model → Task 2 (with the documented QStash/`sesion_courier_batches`/`couriers` deviations noted up front).
- §4.1 recepción flow (multi-courier, no manual quantity, picking-per-session, batch calls, live dup check, message_post, cache write-through) → Tasks 13, 14, 16.
- §4.2 entrega flow (live read, partial selection, signature, backorder-compatible via native `button_validate`) → Tasks 17, 18, 19, 20.
- §5 error handling (never lost work, `action_cancel` not `unlink` — no cancel path is needed in fase 1 since nothing is deleted, only created; retry, message_post, test-base-only) → Task 21, Global Constraints.
- §6 permissions/admin → Tasks 6, 7, 8.
- §7 testing → unit tests embedded per task; Task 22 covers the manual/integration bullet.
- §8 code preferences → followed throughout (explicit TS types, small functions, no dead comments).

**Placeholder scan:** no TBD/TODO; Task 13's `finishCourierBatch` has a short explanatory comment (not a placeholder — it explains a real no-op design choice).

**Type consistency:** `SesionEscaneo`, `SesionCourierBatch`, `SesionItem`, `Almacen`, `Courier`, `Operario` types from Task 2 are the only types referenced by name in later tasks; `PendingDelivery` is defined once in Task 17 and reused in Tasks 18-19; `odoo_move_id` on `sesion_courier_batches` is declared in Task 2 and consumed in Task 16, avoiding the contradiction the brief warned about.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-24-webapp-paqueteria-fase1-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
