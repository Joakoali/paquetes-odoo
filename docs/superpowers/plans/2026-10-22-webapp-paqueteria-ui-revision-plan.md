# Webapp de Paquetería — Plan de implementación: mejora de interfaz y revisión

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rehacer la interfaz de recepción (tablet + pistola), entrega (móvil) y pendientes, y corregir los fallos que encontró la revisión, sin tocar Odoo.

**Architecture:** Se mantiene la arquitectura de la Fase 1: Next.js en Vercel, Neon como base propia, QStash `odoo-sync` (`parallelism: 1`) como único camino de escritura a Odoo. La lógica nueva vive en módulos de dominio (`lib/recepcion`, `lib/entrega`, `lib/maestros`, `lib/sync`) que reciben parámetros explícitos y se testean contra Postgres real en memoria (PGlite). Las server actions solo autentican, chequean acceso al almacén y traducen errores. Almacenes, couriers y barcos se leen de Odoo en un refresco diario; la pantalla "Mapeos" desaparece.

**Tech Stack:** Next.js 16.3 (App Router) + React 19.2 + TypeScript, Drizzle ORM 0.45 (neon-http en producción, PGlite en tests), Upstash QStash 2.11, Vitest 4, CSS propio (sin librerías de UI).

**Spec:** `docs/superpowers/specs/2026-10-22-webapp-paqueteria-ui-revision-design.md`. Bocetos aprobados: `docs/superpowers/specs/mockups/2026-10-22-recepcion-tablet.html` y `docs/superpowers/specs/mockups/2026-10-22-entrega-movil.html`.

**Rama:** `mejora-ui-revision` (ya creada, con el spec commiteado).

## Global Constraints

- Nunca `unlink()` sobre pickings de Odoo; solo `action_cancel()`.
- Odoo admite ≤1 request por segundo, sin paralelismo, para toda la instancia. Toda escritura a Odoo va por la cola QStash `odoo-sync` (`parallelism: 1`). Fuera de la cola solo hay lecturas puntuales (chequeo de duplicados, lectura de entregas pendientes), nunca en loop.
- JSON-2 con body plano vía `odooCall` (`lib/odoo/client.ts`).
- Los campos custom se leen de variables de entorno (`ODOO_FIELD_BARCO`, `ODOO_FIELD_RECIBIDO_POR`, hoy `x_studio_recibido_por_2`); nunca se hardcodean.
- Barcos = `project.project`. Prohibido `partner_id`. Todo lo que agrupa por barco filtra también por almacén / tipo de operación.
- Odoo 19: `stock.move` no tiene `name`; `location_id`/`location_dest_id` explícitos al crear moves; `is_signed` es calculado y de solo lectura (escribir solo `signature`).
- No hay base de test de Odoo. Nada de este plan escribe en Odoo salvo la Task 17, con un barco de QA y aprobación del usuario.
- Next.js 16: leer la guía correspondiente en `node_modules/next/dist/docs/` antes de escribir código de Next (lo pide `AGENTS.md`). Errores esperables de server actions se devuelven como valor (`ResultadoAccion`), no se lanzan. `error.tsx` recibe `{ error, retry }`. Next despacha las server actions de un cliente de a una, en orden.
- neon-http no tiene transacciones: para escrituras atómicas usar `db.batch([...])`.
- Sin librerías de UI nuevas. Único paquete nuevo: `@electric-sql/pglite@0.5.8` como devDependency, solo para tests (versión verificada con drizzle-orm 0.45.2).
- Textos de la interfaz en español rioplatense (voseo), como el spec. Solo tema claro.
- Cada commit agrega solo los archivos de su task (`git add <rutas>`). Nunca `git add -A` ni `git add .`: el árbol tiene cambios del usuario sin commitear (`.gitignore`, `db/seed.ts`, `.vscode/`) que no se tocan. Los mensajes de commit terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Al terminar cada task, `npm test` y `npm run typecheck` quedan en verde. Si una task borra o renombra algo que todavía usa código viejo, en esa misma task se ajusta o se borra ese código (eso está listado en sus "Files").
- Escribir en Neon de producción, en QStash o deployar requiere OK explícito del usuario en ese momento.

## Review Focus

1. **La pistola dispara mientras el escaneo anterior todavía se está verificando.** Cada código tiene que aparecer una sola vez, en orden, sin perderse ni pegarse con el siguiente. → test en Task 13 (`colaReducer`) + chequeo en tablet real en Task 17.
2. **El mismo tracking se escanea en dos recepciones abiertas** (primero el barco equivocado). El segundo escaneo tiene que avisar "ya está en la recepción de <barco>" y no cargarse dos veces. → test en Task 6.
3. **Se corta la conexión al confirmar una entrega en el móvil.** Nombre, firma y selección quedan en pantalla, y reintentar con el mismo id no crea una segunda entrega. → test en Task 10 (`registrarEntrega` idempotente) + chequeo manual en Task 15.
4. **Dos barcos activos con el mismo nombre** ("H3"). Los resultados del buscador se tienen que poder distinguir. → test en Task 3.
5. **Una entrega con líneas sin tracking number** (p. ej. "UPS (incorrecto)"). Se muestran como "sin número" y se pueden elegir. → test en Task 9.

---

### Task 1: Esquema nuevo, migración 0001 y base de tests con PGlite

**Files:**
- Modify: `package.json` (devDependency `@electric-sql/pglite@0.5.8`; script `"typecheck": "tsc --noEmit"`)
- Modify: `db/schema.ts`
- Create (generado): `db/migrations/0001_mejora_ui.sql`, `db/migrations/meta/0001_snapshot.json`; Modify (generado): `db/migrations/meta/_journal.json`
- Create: `lib/testing/test-db.ts`, `lib/testing/seed.ts`
- Create: `db/maintenance/2026-10-22-descartar-sesiones-de-prueba.sql`
- Modify (renombre mecánico `odooPickingTypeId` → `odooInTypeId`): `lib/sync/recepcion.ts`, `lib/sync/recepcion.test.ts`, `app/(app)/entrega/actions.ts`, `app/(app)/entrega/actions.test.ts`, `lib/admin/odooMappings.ts`, `lib/admin/odooMappings.test.ts`, `lib/admin/operarioAlmacenes.test.ts`, `app/admin/mapeos/page.tsx`
- Test: `db/schema.test.ts`, `lib/testing/test-db.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces (propiedades TS de `db/schema.ts`):
  - `errorTipoEnum = pgEnum('error_tipo', ['configuracion', 'odoo', 'conexion'])`; `type ErrorTipo = 'configuracion' | 'odoo' | 'conexion'`.
  - `almacenes`: `id, prefijo, nombre, odooInTypeId` (**misma columna `odoo_picking_type_id`**, solo cambia el nombre TS), `odooOutTypeId` (`odoo_out_type_id`), `odooWarehouseId` (`odoo_warehouse_id`, unique), `activo` (default true).
  - `couriers`: `id, nombre` (pasa a `text`, **sin** unique), `odooProductId` (unique; sigue nullable para no romper `db/seed.ts`, que el usuario tiene modificado sin commitear; el refresco de la Task 3 siempre lo completa), `activo` (default true).
  - `courierUso` (tabla `courier_uso`): `almacenId` (FK), `courierId` (FK), `usos` integer; PK (`almacen_id`, `courier_id`).
  - `barcosCache`: + `activo` (default true).
  - `sesionesEscaneo`: + `odooPickingRef` (text), `receptorNombre` (text), `odooMoveLineIds` (jsonb `number[]`), `ultimoErrorTipo` (`errorTipoEnum`), `revisadoAt` (timestamp), `revisadoPor` (uuid FK operarios); índice único parcial `sesiones_recepcion_abierta_unica` sobre (`almacen_id`, `barco_odoo_id`) `where tipo = 'recepcion' and estado = 'en_curso'` (SQL con nombres de columna sin calificar).
  - `sesionCourierBatches`: + unique (`sesion_id`, `courier_id`).
  - `sesionItems`: + `operarioId` (uuid FK operarios, nullable), `duplicadoRef` (text), `duplicadoAlEnviar` (boolean not null default false).
  - `trackingActivosCache`: + `odooPickingRef` (text).
  - Tipos exportados: `Operario, Almacen, Courier, SesionEscaneo, SesionCourierBatch, SesionItem, BarcoCache, ErrorTipo`.
- Produces (`lib/testing/test-db.ts`): `type TestDb`; `createTestDb(): Promise<TestDb>` (PGlite en memoria, aplica `db/migrations` con el migrator de `drizzle-orm/pglite`, agrega `batch(queries)` que las espera en orden); `resetTestDb(db: TestDb): Promise<void>` (`TRUNCATE` de todas las tablas `RESTART IDENTITY CASCADE`). Patrón de uso en cada test que toca la base:

  ```ts
  vi.mock('@/db/client', async () => ({ db: await (await import('@/lib/testing/test-db')).createTestDb() }))
  import { db } from '@/db/client'
  beforeEach(() => resetTestDb(db as unknown as TestDb))
  ```
- Produces (`lib/testing/seed.ts`): `seedOperario(db, datos?)`, `seedAlmacen(db, datos?)` (default MB92: `odooWarehouseId 1, odooInTypeId 1, odooOutTypeId 2`), `seedCourier(db, datos?)` (default `DHL`, product 11), `seedBarco(db, datos?)` (default `odooId 673, 'MAYANQUEEN'`). Cada una devuelve la fila insertada; los logins se generan únicos.

- [ ] **Step 1: Instalar PGlite y agregar el script**

```bash
npm install -D @electric-sql/pglite@0.5.8
```
Agregar `"typecheck": "tsc --noEmit"` a `scripts`.

- [ ] **Step 2: Escribir los tests que fallan**

`db/schema.test.ts`: agregar `'courierUso'` y `'errorTipoEnum'` a la lista esperada.

`lib/testing/test-db.test.ts`:
```ts
it('rejects a second open recepción for the same almacén and barco', async () => {
  const op = await seedOperario(db); const mb92 = await seedAlmacen(db)
  const base = { operarioId: op.id, almacenId: mb92.id, barcoOdooId: 673, tipo: 'recepcion' as const }
  await db.insert(sesionesEscaneo).values(base)
  await expect(db.insert(sesionesEscaneo).values(base)).rejects.toThrow()
  await db.insert(sesionesEscaneo).values({ ...base, estado: 'sincronizada' }) // no choca: no está en_curso
})
it('resetTestDb empties every table', async () => { /* seed, reset, expect 0 filas en operarios */ })
```

- [ ] **Step 3: Correr y ver que fallan**

Run: `npx vitest run db/schema.test.ts lib/testing/test-db.test.ts`
Expected: FAIL (faltan exports, no existe `lib/testing/test-db.ts`).

- [ ] **Step 4: Cambiar `db/schema.ts` y generar la migración**

Escribir el esquema de "Produces". Usar el estilo de config de tabla con objeto, igual que el archivo actual. Después:
```bash
npx drizzle-kit generate --name mejora_ui
```
Revisar `db/migrations/0001_mejora_ui.sql`. Tiene que tener:
- `CREATE TYPE "public"."error_tipo"`;
- `CREATE TABLE "courier_uso"`;
- `DROP CONSTRAINT "couriers_nombre_unique"`;
- `SET DATA TYPE text`;
- el unique de `odoo_product_id`;
- los `ADD COLUMN` nuevos;
- el unique de (`sesion_id`, `courier_id`);
- `CREATE UNIQUE INDEX "sesiones_recepcion_abierta_unica" ... WHERE tipo = 'recepcion' and estado = 'en_curso'`.

**No** puede tener `DROP COLUMN` ni `RENAME`. Si drizzle-kit pregunta algo de forma interactiva, abortar: significa que detectó un renombre, y el esquema está mal. Después, hacer el renombre mecánico de `odooPickingTypeId` → `odooInTypeId` en los archivos listados en "Files".

- [ ] **Step 5: Escribir `lib/testing/test-db.ts`, `lib/testing/seed.ts` y el SQL de limpieza**

`db/maintenance/2026-10-22-descartar-sesiones-de-prueba.sql` (se corre en producción en la Task 17, antes de la migración, porque hoy hay dos recepciones `en_curso` de MAYANQUEENIV/MB92 que chocarían con el índice):
```sql
-- Recepciones de prueba que quedaron en_curso. Confirmado por el usuario el 2026-10-22.
DELETE FROM sesion_items WHERE courier_batch_id IN (
  SELECT b.id FROM sesion_courier_batches b JOIN sesiones_escaneo s ON s.id = b.sesion_id WHERE s.estado = 'en_curso');
DELETE FROM sesion_courier_batches WHERE sesion_id IN (SELECT id FROM sesiones_escaneo WHERE estado = 'en_curso');
DELETE FROM sesiones_escaneo WHERE estado = 'en_curso';
```

- [ ] **Step 6: Correr los tests**

Run: `npx vitest run db/schema.test.ts lib/testing/test-db.test.ts` → PASS. Después `npm test` y `npm run typecheck` → todo en verde.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json db/schema.ts db/schema.test.ts db/migrations lib/testing db/maintenance lib/sync/recepcion.ts lib/sync/recepcion.test.ts "app/(app)/entrega/actions.ts" "app/(app)/entrega/actions.test.ts" lib/admin app/admin/mapeos/page.tsx
git commit -m "feat: schema for shared open receptions, Odoo masters and PGlite test db"
```

---

### Task 2: Errores de Odoo clasificados

**Files:**
- Modify: `lib/odoo/client.ts`, `lib/odoo/client.test.ts`
- Create: `lib/errores.ts`, `lib/errores.test.ts`
- Modify: `lib/odoo/pickings.ts` (lanzar `ConfiguracionError` si falta `ODOO_FIELD_BARCO`)

**Interfaces:**
- Consumes: `ErrorTipo` (Task 1).
- Produces:
  - `class OdooError extends Error { readonly status: number; readonly odooName: string | null; readonly data: unknown }`, `constructor(info: { status: number; data: unknown })`. `message` = el `message` que manda Odoo si existe; si no, `Odoo call failed: <json>`.
  - `odooCall` corta a los `ODOO_TIMEOUT_MS = 30_000` (`AbortSignal.timeout`).
  - `lib/errores.ts`: `class ErrorParaOperario extends Error` (su `message` se le puede mostrar al operario); `class ConfiguracionError extends ErrorParaOperario`; `class RespuestaOdooInesperadaError extends Error`; `clasificarError(err: unknown): ErrorTipo`; `mensajeProblema(tipo: ErrorTipo): string`.
  - Reglas de `clasificarError`: `ConfiguracionError` → `'configuracion'`. `OdooError` con status 429/502/503/504, o 500 sin `odooName` → `'conexion'`. Errores con `name` `'TimeoutError'` o `'AbortError'`, o `TypeError` con "fetch failed" → `'conexion'`. Cualquier otro → `'odoo'`.
  - Textos exactos de `mensajeProblema`:
    - `configuracion`: "No se pudo enviar a Odoo: falta configuración. Lo tiene que arreglar el admin."
    - `conexion`: "Odoo no respondió. Se reintentó solo y no hubo caso. Probá Reintentar en un rato."
    - `odoo`: "Odoo rechazó el envío. Mirá el detalle o avisá al admin."

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// lib/errores.test.ts
it.each([
  [new ConfiguracionError('x'), 'configuracion'],
  [new OdooError({ status: 503, data: null }), 'conexion'],
  [new OdooError({ status: 429, data: null }), 'conexion'],
  [new OdooError({ status: 500, data: 'bad gateway html' }), 'conexion'],
  [new OdooError({ status: 422, data: { name: 'odoo.exceptions.ValidationError', message: 'x' } }), 'odoo'],
  [new OdooError({ status: 500, data: { name: 'odoo.exceptions.UserError', message: 'x' } }), 'odoo'],
  [new TypeError('fetch failed'), 'conexion'],
  [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'conexion'],
  [new Error('picking 5 no existe en Odoo'), 'odoo'],
])('clasificarError(%o) → %s', (err, tipo) => expect(clasificarError(err)).toBe(tipo))
```
```ts
// lib/odoo/client.test.ts (nuevo caso)
it('OdooError exposes status, the Odoo exception name and its message', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422,
    text: async () => JSON.stringify({ name: 'odoo.exceptions.ValidationError', message: 'Missing required field' }) }))
  const err = await odooCall('stock.move', 'create', {}).catch((e) => e)
  expect(err).toBeInstanceOf(OdooError)
  expect(err).toMatchObject({ status: 422, odooName: 'odoo.exceptions.ValidationError', message: 'Missing required field' })
})
```

- [ ] **Step 2: Correr y ver que fallan** — Run: `npx vitest run lib/errores.test.ts lib/odoo/client.test.ts` → FAIL.

- [ ] **Step 3: Implementar** `lib/errores.ts` y los cambios de `lib/odoo/client.ts` según "Produces". En `lib/odoo/pickings.ts`, la falta de `ODOO_FIELD_BARCO` lanza `ConfiguracionError('ODOO_FIELD_BARCO no está configurado')`.

- [ ] **Step 4: Correr** — `npx vitest run lib/errores.test.ts lib/odoo/client.test.ts lib/odoo/pickings.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/errores.ts lib/errores.test.ts lib/odoo/client.ts lib/odoo/client.test.ts lib/odoo/pickings.ts
git commit -m "feat: classify Odoo failures into configuracion, odoo and conexion"
```

---

### Task 3: Almacenes, couriers y barcos leídos de Odoo

**Files:**
- Create: `lib/fechas.ts`, `lib/fechas.test.ts`
- Create: `lib/odoo/maestros.ts`, `lib/odoo/maestros.test.ts`
- Create: `lib/maestros/refresh.ts`, `lib/maestros/refresh.test.ts`
- Modify: `lib/cache/barcos.ts`, `lib/cache/barcos.test.ts` (reescribir con PGlite)
- Modify: `app/(app)/barcos-actions.ts` (devuelve `etiqueta`)
- Modify: `app/api/qstash/refresh-barcos/route.ts` (llama a `refreshMaestros` en vez de `refreshBarcosCache`; la Task 5 la reemplaza)

**Interfaces:**
- Consumes: esquema (Task 1), `odooCall` (Task 2).
- Produces:
  - `lib/fechas.ts`: `ZONA_HORARIA = 'Europe/Madrid'`; `formatFechaOdoo(fecha: Date): string` (`'YYYY-MM-DD HH:MM:SS'` en UTC); `parseFechaOdoo(texto: string): Date` (interpreta UTC).
  - `lib/odoo/maestros.ts`:
    - `interface AlmacenOdoo { warehouseId: number; codigo: string; nombre: string; inTypeId: number; outTypeId: number }`; `fetchAlmacenes(): Promise<AlmacenOdoo[]>` → `stock.warehouse` `search_read`, fields `['code','name','in_type_id','out_type_id']`.
    - `interface CourierOdoo { productId: number; nombre: string }`; `fetchCouriers(): Promise<CourierOdoo[]>` → `product.product` `search_read`, domain `[['tracking','=','serial']]`, fields `['name']`.
    - `interface UsoCourierOdoo { inTypeId: number; productId: number; usos: number }`; `fetchUsoCouriers(desde: Date): Promise<UsoCourierOdoo[]>` → `stock.move.line` `search_read`, domain `[['picking_code','=','incoming'],['state','=','done'],['date','>=', formatFechaOdoo(desde)]]`, fields `['product_id','picking_type_id']`, agregado en JS.
    - `interface BarcoOdoo { odooId: number; nombre: string }`; `fetchBarcos(): Promise<BarcoOdoo[]>` → `project.project` `search_read`, fields `['name']`.
  - `lib/maestros/refresh.ts`: `DIAS_USO_COURIERS = 90`; `interface ResumenRefresco { almacenes: number; couriers: number; barcos: number }`; `refreshMaestros(ahora?: Date): Promise<ResumenRefresco>`; `ultimoRefresco(): Promise<Date | null>` (= máximo `barcos_cache.updated_at`).
    - **Almacenes:** cada warehouse se busca por `odooWarehouseId`. Si no está, se busca por `prefijo = codigo` con `odooWarehouseId` nulo, para conservar el `id` y las asignaciones de operarios. Si tampoco, se inserta. Se setean `prefijo`, `nombre`, `odooInTypeId`, `odooOutTypeId` y `activo = true`. Los que no vinieron de Odoo quedan `activo = false` (MLC).
    - **Couriers:** upsert por `odooProductId` (nombre de Odoo, `activo = true`). Los que no vinieron quedan `activo = false`.
    - **Barcos:** igual, por `odooId`, con `updatedAt`.
    - **Uso:** se reemplaza `courier_uso` con un `db.batch([delete, insert])`. `inTypeId` se mapea a `almacenes.id` y `productId` a `couriers.id`; los que no matchean se descartan.
    - Si Odoo devuelve una lista vacía, esa sección no se toca (no se desactiva todo).
  - `lib/cache/barcos.ts`: `BUSQUEDA_BARCOS_LIMITE = 20`; `interface BarcoOpcion { odooId: number; nombre: string; etiqueta: string }`; `searchBarcos(query: string): Promise<BarcoOpcion[]>`. Solo activos, `ilike` con `%` y `_` escapados, orden por nombre, máximo 20. `etiqueta` = nombre, o `` `${nombre} · #${odooId}` `` si en el resultado hay otro con el mismo nombre (sin distinguir mayúsculas). Se elimina `refreshBarcosCache` (vive en `refreshMaestros`).

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// lib/fechas.test.ts
it('formatFechaOdoo writes UTC in Odoo format', () =>
  expect(formatFechaOdoo(new Date('2026-07-24T09:05:03Z'))).toBe('2026-07-24 09:05:03'))
it('parseFechaOdoo reads Odoo datetimes as UTC', () =>
  expect(parseFechaOdoo('2026-09-29 11:12:15').toISOString()).toBe('2026-09-29T11:12:15.000Z'))
```
```ts
// lib/odoo/maestros.test.ts (odooCall mockeado)
it('fetchAlmacenes maps each warehouse to its reception and delivery types', async () => {
  vi.mocked(odooCall).mockResolvedValue([{ id: 1, code: 'MB92', name: 'MB92 - Barcelona', in_type_id: [1, 'x'], out_type_id: [2, 'y'] }])
  expect(await fetchAlmacenes()).toEqual([{ warehouseId: 1, codigo: 'MB92', nombre: 'MB92 - Barcelona', inTypeId: 1, outTypeId: 2 }])
})
it('fetchCouriers reads only serial-tracked products', async () => { /* expect domain [['tracking','=','serial']] */ })
it('fetchUsoCouriers counts done incoming lines per reception type and product since a date', async () => {
  vi.mocked(odooCall).mockResolvedValue([
    { product_id: [11, 'DHL'], picking_type_id: [1, 'x'] }, { product_id: [11, 'DHL'], picking_type_id: [1, 'x'] },
    { product_id: [69, 'Chronopost'], picking_type_id: [9, 'y'] }])
  expect(await fetchUsoCouriers(new Date('2026-07-24T00:00:00Z'))).toEqual(expect.arrayContaining([
    { inTypeId: 1, productId: 11, usos: 2 }, { inTypeId: 9, productId: 69, usos: 1 }]))
  expect(vi.mocked(odooCall).mock.calls[0][2]).toMatchObject({ domain: expect.arrayContaining([['date', '>=', '2026-07-24 00:00:00']]) })
})
```
```ts
// lib/maestros/refresh.test.ts (PGlite; maestros de Odoo mockeados)
it('links existing almacenes by prefijo on the first refresh and keeps their ids', async () => {
  const mb92 = await seedAlmacen(db, { prefijo: 'MB92', odooWarehouseId: null, odooOutTypeId: null })
  await refreshMaestros()
  const fila = await db.query.almacenes.findFirst({ where: eq(almacenes.id, mb92.id) })
  expect(fila).toMatchObject({ odooWarehouseId: 1, odooInTypeId: 1, odooOutTypeId: 2, activo: true })
})
it('deactivates almacenes Odoo no longer has (MLC) and adds new ones (TGN, COPIA)', ...)
it('upserts couriers by product id: renames, adds and deactivates', async () => {
  await seedCourier(db, { nombre: 'Amazon', odooProductId: 11 }); await seedCourier(db, { nombre: 'UPS', odooProductId: 21 })
  // Odoo devuelve [{11,'DHL'},{125,'UPS (correcto)'}]
  await refreshMaestros()
  // 11 → 'DHL' activo; 21 → activo false; 125 insertado
})
it('replaces courier_uso with per-almacén counts', ...)
it('marks barcos missing in Odoo as inactive and renames the rest', ...)
it('leaves a section untouched when Odoo returns an empty list', ...)
```
```ts
// lib/cache/barcos.test.ts (PGlite)
it('returns only active barcos, ordered by name, at most 20', ...)
it('treats % and _ in the query literally', ...)
it('labels same-named active barcos with their Odoo id', async () => {
  await seedBarco(db, { odooId: 942, nombre: 'H3' }); await seedBarco(db, { odooId: 943, nombre: 'H3' })
  expect((await searchBarcos('h3')).map((b) => b.etiqueta)).toEqual(['H3 · #942', 'H3 · #943'])
})
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/fechas.test.ts lib/odoo/maestros.test.ts lib/maestros lib/cache/barcos.test.ts` → FAIL.

- [ ] **Step 3: Implementar** según "Produces". `refreshMaestros` llama a Odoo en este orden: almacenes, couriers, barcos, uso. Son 4 lecturas; el throttle de `odooCall` las espacia.

- [ ] **Step 4: Correr** los mismos tests → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/fechas.ts lib/fechas.test.ts lib/odoo/maestros.ts lib/odoo/maestros.test.ts lib/maestros lib/cache/barcos.ts lib/cache/barcos.test.ts "app/(app)/barcos-actions.ts" app/api/qstash/refresh-barcos/route.ts
git commit -m "feat: read almacenes, couriers and barcos from Odoo instead of manual mappings"
```

---

### Task 4: Cache de tracking numbers completa desde Odoo

**Files:**
- Modify: `lib/odoo/maestros.ts`, `lib/odoo/maestros.test.ts`
- Modify: `lib/cache/trackingActivos.ts`, `lib/cache/trackingActivos.test.ts` (reescribir con PGlite)
- Modify (ajuste mecánico): `app/(app)/recepcion/actions.ts` y su test pasan de `isKnownDuplicate(t)` a `(await buscarDuplicado(t)) !== null`. La Task 7 reescribe ese archivo.

**Interfaces:**
- Consumes: esquema (Task 1), `odooCall` (Task 2).
- Produces:
  - `interface LineaTrackingOdoo { trackingNumber: string; pickingId: number; pickingRef: string; esRecepcion: boolean }`; `fetchLineasConTracking(pagina: { offset: number; limit: number }): Promise<LineaTrackingOdoo[]>` → `stock.move.line` `search_read`, domain `[['lot_id','!=',false],['state','!=','cancel']]`, fields `['lot_id','picking_id','picking_code']`, `order: 'id'`, `offset`, `limit`.
  - `PAGINA_TRACKINGS = 2000`.
  - `buscarDuplicado(trackingNumber: string): Promise<{ odooPickingRef: string } | null>`. Reemplaza a `isKnownDuplicate`; si la fila no tiene ref, devuelve `` `picking #${odooPickingId}` ``.
  - `recordSyncedTrackings(filas: Array<{ trackingNumber: string; odooPickingId: number; odooPickingRef?: string | null }>): Promise<void>` (upsert multi-fila, `updatedAt = now()`; el worker actual sigue compilando sin pasar la ref, y la Task 8 la agrega).
  - `refreshTrackingActivos(): Promise<{ filas: number }>`. Funciona con marca y barrido:
    1. `inicio = new Date()`.
    2. Pagina Odoo hasta que una página trae menos de `PAGINA_TRACKINGS` filas.
    3. Arma en memoria un `Map` tracking → picking. Si el tracking está en una recepción y en una entrega, se queda con la recepción.
    4. Upsert en tandas de 1000.
    5. Borra las filas con `updatedAt < inicio`.
  - Se eliminan `isKnownDuplicate` y `recordSyncedTracking` (singular).

- [ ] **Step 1: Escribir los tests que fallan**

```ts
it('buscarDuplicado returns the Odoo reference of a known tracking', ...)
it('refreshTrackingActivos pages through Odoo until a short page', async () => {
  // odooCall: 1ª llamada 2000 filas, 2ª llamada 3 filas → 2 llamadas, offsets 0 y 2000
})
it('prefers the reception reference when a tracking is in a reception and a delivery', ...)
it('removes trackings that are no longer in Odoo', async () => {
  await db.insert(trackingActivosCache).values({ trackingNumber: 'VIEJO', odooPickingId: 1, updatedAt: new Date('2026-01-01') })
  await refreshTrackingActivos()
  expect(await buscarDuplicado('VIEJO')).toBeNull()
})
it('keeps a row written by a sync while the refresh was running', ...)
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/cache/trackingActivos.test.ts lib/odoo/maestros.test.ts` → FAIL.
- [ ] **Step 3: Implementar** según "Produces".
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/odoo/maestros.ts lib/odoo/maestros.test.ts lib/cache/trackingActivos.ts lib/cache/trackingActivos.test.ts "app/(app)/recepcion/actions.ts" "app/(app)/recepcion/actions.test.ts"
git commit -m "feat: nightly tracking cache rebuild from Odoo with picking references"
```

---

### Task 5: Cola sin bloqueos, auditoría y rutas de QStash

**Files:**
- Modify: `lib/queue/publish.ts`, `lib/queue/publish.test.ts`
- Create: `lib/audit.ts`, `lib/audit.test.ts`
- Create: `lib/sync/estado.ts`, `lib/sync/estado.test.ts`
- Modify: `app/api/qstash/sync-session/route.ts`; Create: `app/api/qstash/sync-session/route.test.ts`
- Create: `app/api/qstash/refresh-maestros/route.ts`, `app/api/qstash/refresh-trackings/route.ts`
- Delete: `app/api/qstash/refresh-barcos/route.ts`
- Modify: `app/api/cron/refresh-caches/route.ts`, `app/api/cron/refresh-caches/route.test.ts`
- Modify (ajuste mecánico): `app/admin/actions.ts` (`refreshBarcosAction` encola los dos refrescos nuevos; la Task 16 lo reescribe)

**Interfaces:**
- Consumes: `clasificarError` (Task 2), `refreshMaestros` (Task 3), `refreshTrackingActivos` (Task 4).
- Produces:
  - `publish.ts`:
    - `MAX_REINTENTOS = 2`.
    - `publishSync({ sesionId })` encola `{ url: ${APP_BASE_URL}/api/qstash/sync-session, body, retries: MAX_REINTENTOS, retryDelay: '10000 * (1 + retried)' }`.
    - `publishRefreshMaestros()` y `publishRefreshTrackings()` encolan a `/api/qstash/refresh-maestros` y `/api/qstash/refresh-trackings` con `retries: 1`.
    - Se elimina `publishRefreshBarcos`.
  - `lib/audit.ts`:
    - `type AccionAuditoria = 'recepcion_enviada' | 'recepcion_descartada' | 'entrega_confirmada' | 'sync_ok' | 'sync_error' | 'reintento' | 'revisado' | 'admin_operario_creado' | 'admin_operario_activo' | 'admin_almacenes' | 'admin_refresco'`.
    - `registrarAuditoria(entrada: { operarioId: string | null; accion: AccionAuditoria; detalle?: Record<string, unknown> }): Promise<void>`. Nunca lanza: si falla, `console.error` y sigue.
  - `lib/sync/estado.ts`: `registrarFalloSync(entrada: { sesionId: string; error: unknown; reintentosHechos: number }): Promise<{ final: boolean; tipo: ErrorTipo }>`.
    - Siempre: `intentos + 1`, `ultimoError = message` y `ultimoErrorTipo = tipo`.
    - Un fallo es final si el tipo no es `conexion` o si `reintentosHechos >= MAX_REINTENTOS`. Si es final, `estado = 'error'`; si no, el estado no cambia.
    - Registra `sync_error` en la auditoría.
  - Ruta `sync-session`:
    - Si el sync sale bien, responde 200.
    - Si falla, `reintentosHechos = Number(request.headers.get('upstash-retried') ?? 0)` y responde **200 cuando el fallo es final** (QStash no reintenta y la cola sigue) o **500 si no es final** (QStash reintenta).
  - Rutas `refresh-maestros` y `refresh-trackings`: verifican la firma, corren el refresco, registran `admin_refresco` en la auditoría con el resumen y `operarioId: null`, y responden 200. Si fallan, 500. Ambas con `maxDuration = 300`.
  - Cron: encola los dos refrescos.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// publish.test.ts
it('publishSync enqueues with bounded retries and a short delay', async () => {
  await publishSync({ sesionId: 's1' })
  expect(enqueueJSON).toHaveBeenCalledWith({ url: 'https://app.example.com/api/qstash/sync-session',
    body: { sesionId: 's1' }, retries: 2, retryDelay: '10000 * (1 + retried)' })
})
it('publishRefreshMaestros and publishRefreshTrackings enqueue their routes', ...)
```
```ts
// lib/sync/estado.test.ts (PGlite)
it('a connection failure before the last retry keeps the session pending and is not final', async () => {
  const r = await registrarFalloSync({ sesionId: s.id, error: new TypeError('fetch failed'), reintentosHechos: 0 })
  expect(r).toEqual({ final: false, tipo: 'conexion' })
  expect(await estadoDe(s.id)).toMatchObject({ estado: 'confirmada_pendiente_sync', intentos: 1, ultimoErrorTipo: 'conexion' })
})
it('a connection failure on the last retry marks the session in error', ...)          // reintentosHechos: 2 → final, estado 'error'
it('a configuration error is final on the first attempt', ...)                       // tipo 'configuracion'
```
```ts
// sync-session/route.test.ts (verify, syncs y registrarFalloSync mockeados)
it('returns 500 so QStash retries when the failure is not final', ...)
it('returns 200 when the failure is final so the queue never blocks', ...)
it('passes the upstash-retried header as reintentosHechos', ...)
it('rejects a bad signature with 401', ...)
```
```ts
// cron route.test.ts
it('enqueues the maestros and trackings refresh with the right bearer token', ...)
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/queue lib/audit.test.ts lib/sync/estado.test.ts app/api` → FAIL.
- [ ] **Step 3: Implementar** según "Produces". Antes de escribir las rutas, leer `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`.
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/queue lib/audit.ts lib/audit.test.ts lib/sync/estado.ts lib/sync/estado.test.ts app/api app/admin/actions.ts
git commit -m "fix: bounded QStash retries so one failing sync never blocks the queue"
```

---

### Task 6: Dominio de recepción (recepciones abiertas compartidas)

**Files:**
- Modify: `lib/fechas.ts`, `lib/fechas.test.ts`
- Create: `lib/recepcion/recepciones.ts`, `lib/recepcion/recepciones.test.ts`

**Interfaces:**
- Consumes: esquema (Task 1), `ErrorParaOperario` (Task 2), `buscarDuplicado` (Task 4), `publishSync` y `registrarAuditoria` (Task 5).
- Produces:
  - `lib/fechas.ts`:
    - `inicioDeHoy(ahora: Date): Date` devuelve las 00:00 de `ZONA_HORARIA` como instante UTC.
    - `haceCuanto(desde: Date, ahora: Date): string` → `"recién"` (<1 min), `"hace N min"`, `"hace N h"` (<24 h), `"ayer"`, `"hace N días"`.
  - `lib/recepcion/recepciones.ts` (las funciones confían en sus parámetros; la autorización la hacen las actions):
    - Errores: `class RecepcionCerradaError extends ErrorParaOperario` ("Esta recepción ya se envió a Odoo."). `class EscaneoInvalidoError extends ErrorParaOperario` ("El código está vacío." / "La recepción no existe.").
    - `interface PaqueteEscaneado { id: string; trackingNumber: string; courierId: number; courierNombre: string; estado: 'ok' | 'duplicado'; duplicadoRef: string | null }`.
    - `type ResultadoEscaneo = { tipo: 'agregado'; paquete: PaqueteEscaneado } | { tipo: 'repetido'; trackingNumber: string; donde: string }`.
    - `abrirRecepcion(entrada: { almacenId: number; barcoOdooId: number; operarioId: string }): Promise<string>`: insert con `onConflictDoNothing()` y después busca la abierta. Devuelve siempre la recepción abierta de ese almacén y barco.
    - `escanearPaquete(entrada: { sesionId: string; courierId: number; trackingNumber: string; operarioId: string }): Promise<ResultadoEscaneo>`. Pasos, en orden:
      1. Recortar espacios. Si el código queda vacío, `EscaneoInvalidoError`.
      2. Si la recepción no está `en_curso`, `RecepcionCerradaError`.
      3. Si el código ya está en esta recepción, devolver `repetido` con `donde: 'esta recepción'`.
      4. Si está en otra recepción `en_curso` o `confirmada_pendiente_sync`, devolver `repetido` con `donde: \`la recepción de ${barco}\``.
      5. Consultar `buscarDuplicado`: si aparece, el estado es `'duplicado'` con su `duplicadoRef`.
      6. Buscar o crear la tanda (batch) del courier.
      7. Insertar el paquete con `operarioId`, con `onConflictDoNothing()`. Si no insertó nada, devolver `repetido`.
    - `borrarPaquete(itemId: string): Promise<void>` (solo con la recepción `en_curso`; si no, `RecepcionCerradaError`).
    - `descartarRecepcion(entrada: { sesionId: string; operarioId: string }): Promise<void>`: borra paquetes, tandas y sesión con `db.batch`, solo si está `en_curso`, y registra `recepcion_descartada`.
    - `type ResultadoEnvio = 'enviada' | 'sin_paquetes_validos' | 'vacia_descartada'`.
    - `enviarRecepcion(entrada: { sesionId: string; operarioId: string }): Promise<ResultadoEnvio>`:
      - Sin paquetes: la descarta y devuelve `vacia_descartada`.
      - Solo duplicados: devuelve `sin_paquetes_validos`.
      - Con paquetes válidos: `estado = 'confirmada_pendiente_sync'`, `confirmedAt` y `publishSync`. Si `publishSync` falla, vuelve a `en_curso` y relanza. Después de publicar, registra `recepcion_enviada`.
    - `enviarRecepcionesAbiertas(entrada: { almacenId: number; operarioId: string; barcoOdooId?: number }): Promise<number>`: devuelve cuántas envió.
    - `interface RecepcionAbierta { id: string; barcoOdooId: number; barcoNombre: string; paquetes: number; porCourier: Array<{ nombre: string; cantidad: number }>; abiertaDesde: Date }`. `listarRecepcionesAbiertas(almacenId: number): Promise<RecepcionAbierta[]>`: solo las que tienen al menos un paquete; `barcoNombre` cae a `` `Barco #${id}` `` si el barco no está en la cache.
    - `interface RecepcionEnviada { id: string; barcoNombre: string; paquetes: number; estado: 'enviando' | 'ok' | 'problema'; odooPickingRef: string | null; enviadaAt: Date }`. `listarEnviadasHoy(almacenId: number, ahora?: Date): Promise<RecepcionEnviada[]>`. Estados:
      - `confirmada_pendiente_sync` → `enviando`;
      - `sincronizada` sin `ultimoError` → `ok`;
      - `sincronizada` con `ultimoError`, o `error` → `problema`.
    - `interface RecepcionDetalle { id: string; almacenId: number; barcoOdooId: number; barcoNombre: string; estado: SesionEscaneo['estado']; paquetes: PaqueteEscaneado[] }`. `getRecepcion(sesionId: string): Promise<RecepcionDetalle | null>`: los paquetes vienen del más nuevo al más viejo.
    - `contarSinEnviarPorBarco(almacenId: number): Promise<Map<number, number>>`: paquetes `ok` en recepciones `en_curso`, por barco.

- [ ] **Step 1: Escribir los tests que fallan** (PGlite; `publishSync`, `registrarAuditoria` mockeados)

```ts
it('reuses the open recepción of the same almacén and barco, even from another operario', async () => {
  const a = await abrirRecepcion({ almacenId: mb92.id, barcoOdooId: 673, operarioId: veronika.id })
  const b = await abrirRecepcion({ almacenId: mb92.id, barcoOdooId: 673, operarioId: eduardo.id })
  expect(b).toBe(a)
})
it('adds a package under the chosen courier, creating the courier batch once, and records who scanned it', ...)
it('flags a package already in Odoo as duplicado with its reference', async () => {
  await db.insert(trackingActivosCache).values({ trackingNumber: 'JJD1', odooPickingId: 9, odooPickingRef: 'MB92/IN/00198' })
  const r = await escanearPaquete({ sesionId, courierId: dhl.id, trackingNumber: 'JJD1', operarioId: veronika.id })
  expect(r).toMatchObject({ tipo: 'agregado', paquete: { estado: 'duplicado', duplicadoRef: 'MB92/IN/00198' } })
})
it('reports a re-scan in the same recepción as repetido and inserts nothing', ...)
it('reports a package already in another open recepción as repetido, naming that barco', async () => {
  const otra = await abrirRecepcion({ almacenId: mb92.id, barcoOdooId: 674, operarioId: veronika.id }) // MAYANQUEENIV
  await escanearPaquete({ sesionId: otra, courierId: dhl.id, trackingNumber: 'XW1', operarioId: veronika.id })
  const r = await escanearPaquete({ sesionId, courierId: dhl.id, trackingNumber: 'XW1', operarioId: veronika.id })
  expect(r).toEqual({ tipo: 'repetido', trackingNumber: 'XW1', donde: 'la recepción de MAYANQUEENIV' })
})
it('trims the code and rejects an empty one', ...)
it('rejects scanning into a recepción that was already sent', ...)
it('borrarPaquete deletes from an open recepción and refuses once sent', ...)
it('enviarRecepcion marks it confirmada and publishes it', ...)
it('enviarRecepcion discards an empty recepción instead of sending it', ...)
it('enviarRecepcion does not send a recepción with only duplicados', ...)
it('enviarRecepcion goes back to en_curso when publishing fails', ...)
it('enviarRecepcionesAbiertas sends every open recepción with valid packages, optionally for one barco', ...)
it('listarRecepcionesAbiertas counts packages per courier and skips empty ones', ...)
it('listarEnviadasHoy maps estados and only includes today in Madrid time', ...)
it('contarSinEnviarPorBarco counts valid packages of open recepciones per barco', ...)
```
```ts
// lib/fechas.test.ts
it('inicioDeHoy is midnight in Madrid, in summer and in winter', () => {
  expect(inicioDeHoy(new Date('2026-07-24T10:00:00Z')).toISOString()).toBe('2026-07-23T22:00:00.000Z')
  expect(inicioDeHoy(new Date('2026-12-02T10:00:00Z')).toISOString()).toBe('2026-12-01T23:00:00.000Z')
})
it('haceCuanto speaks plain Spanish', ...)
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/recepcion lib/fechas.test.ts` → FAIL.
- [ ] **Step 3: Implementar** según "Produces".
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/fechas.ts lib/fechas.test.ts lib/recepcion
git commit -m "feat: shared open receptions per almacén with cross-reception duplicate check"
```

---

### Task 7: Almacén activo y server actions de recepción

**Files:**
- Create: `lib/acciones.ts`, `lib/acciones.test.ts`
- Create: `lib/almacen-activo.ts`, `lib/almacen-activo.test.ts`
- Modify: `lib/admin/operarioAlmacenes.ts`, `lib/admin/operarioAlmacenes.test.ts` (reescribir con PGlite)
- Modify: `app/(app)/recepcion/actions.ts`, `app/(app)/recepcion/actions.test.ts` (reescribir)
- Create: `app/(app)/almacen-actions.ts`, `app/(app)/almacen-actions.test.ts`
- Delete: `app/(app)/recepcion/ScanClient.tsx` (usa las actions viejas). Mientras tanto, `app/(app)/recepcion/page.tsx` queda como un `<h1>Recepción</h1>` provisorio, que se reemplaza en la Task 14. La rama no se deploya hasta la Task 17.

**Interfaces:**
- Consumes: Task 6, `requireOperarioFromCookies`, `operarioHasAlmacen`.
- Produces:
  - `lib/acciones.ts`: `type ResultadoAccion<T = void> = { ok: true; valor: T } | { ok: false; error: string }`; `ejecutarAccion<T>(fn: () => Promise<T>): Promise<ResultadoAccion<T>>`.
    - Primero llama a `unstable_rethrow(err)` (de `next/navigation`), así `redirect`/`notFound` siguen funcionando.
    - Después traduce el error:
      - `UnauthorizedError` → "Tu sesión venció. Volvé a entrar."
      - `ForbiddenError` → "No tenés acceso a esto."
      - `ErrorParaOperario` → su `message`.
      - Cualquier otro → `console.error` y "Algo falló. Probá de nuevo."
  - `lib/almacen-activo.ts`: `ALMACEN_COOKIE = 'paqueteria_almacen'`; `interface AlmacenesDelOperario { activo: Almacen | null; disponibles: Almacen[] }`; `getAlmacenActivo(operarioId: string): Promise<AlmacenesDelOperario>` (lee la cookie y la valida contra los almacenes asignados y activos; si no sirve, usa el primero); `requireAlmacenActivo(operarioId: string): Promise<Almacen>` (sin almacenes → `ErrorParaOperario('No tenés almacenes asignados. Avisá al admin.')`).
  - `getAlmacenesForOperario` devuelve solo almacenes `activo`.
  - `app/(app)/almacen-actions.ts`: `elegirAlmacenAction(almacenId: number): Promise<ResultadoAccion>`. Chequea acceso y guarda la cookie (`httpOnly`, `sameSite: 'lax'`, `path: '/'`, `maxAge` 1 año).
  - `app/(app)/recepcion/actions.ts` (todas con `ejecutarAccion`; las que reciben `sesionId`/`itemId` verifican que el operario tenga el almacén de esa recepción):
    - `abrirRecepcionAction(barcoOdooId: number): Promise<ResultadoAccion<{ sesionId: string }>>` (usa el almacén activo)
    - `escanearAction(entrada: { sesionId: string; courierId: number; trackingNumber: string }): Promise<ResultadoAccion<ResultadoEscaneo>>`
    - `borrarPaqueteAction(itemId: string): Promise<ResultadoAccion>`
    - `enviarRecepcionAction(sesionId: string): Promise<ResultadoAccion<ResultadoEnvio>>`
    - `enviarTodasAction(): Promise<ResultadoAccion<{ enviadas: number }>>`
    - `descartarRecepcionAction(sesionId: string): Promise<ResultadoAccion>`
    - `asignarYEscanearAction(entrada: { barcoOdooId: number; courierId: number; trackingNumber: string }): Promise<ResultadoAccion<{ sesionId: string; resultado: ResultadoEscaneo }>>`
    - Las que cambian listas del inicio (`enviar*`, `descartar*`) llaman a `revalidatePath('/recepcion')`. `escanearAction` **no** revalida (cada escaneo tiene que ser liviano).

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// lib/acciones.test.ts
it('maps an expired session to a friendly message', async () =>
  expect(await ejecutarAccion(async () => { throw new UnauthorizedError('x') }))
    .toEqual({ ok: false, error: 'Tu sesión venció. Volvé a entrar.' }))
it('shows ErrorParaOperario messages as they are', ...)
it('hides unexpected errors behind a generic message', ...)
```
```ts
// lib/almacen-activo.test.ts (PGlite + next/headers mockeado)
it('defaults to the first assigned active almacén', ...)
it('uses the cookie when it points to an assigned almacén', ...)
it('ignores a cookie for an almacén the operario cannot use', ...)
it('skips almacenes that are no longer active', ...)
```
```ts
// app/(app)/recepcion/actions.test.ts (dominio y auth mockeados)
it('escanearAction refuses a recepción of an almacén the operario does not have', async () => {
  vi.mocked(operarioHasAlmacen).mockResolvedValue(false)
  expect(await escanearAction({ sesionId: 's1', courierId: 1, trackingNumber: 'T1' }))
    .toEqual({ ok: false, error: 'No tenés acceso a esto.' })
  expect(escanearPaquete).not.toHaveBeenCalled()
})
it('abrirRecepcionAction opens the recepción in the active almacén', ...)
it('enviarTodasAction sends the open recepciones of the active almacén', ...)
```
```ts
// app/(app)/almacen-actions.test.ts (cookies y auth mockeados)
it('refuses an almacén the operario is not assigned to and leaves the cookie alone', ...)
it('stores the chosen almacén in the paqueteria_almacen cookie for a year', ...)
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/acciones.test.ts lib/almacen-activo.test.ts lib/admin "app/(app)/recepcion" "app/(app)/almacen-actions.test.ts"` → FAIL.
- [ ] **Step 3: Implementar.** Antes, leer `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md`, `.../03-api-reference/04-functions/cookies.md` y `.../unstable_rethrow.md`.
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/acciones.ts lib/acciones.test.ts lib/almacen-activo.ts lib/almacen-activo.test.ts lib/admin/operarioAlmacenes.ts lib/admin/operarioAlmacenes.test.ts "app/(app)/recepcion/actions.ts" "app/(app)/recepcion/actions.test.ts" "app/(app)/recepcion/page.tsx" "app/(app)/almacen-actions.ts" "app/(app)/almacen-actions.test.ts"
git rm "app/(app)/recepcion/ScanClient.tsx"
git commit -m "feat: active almacén cookie and reception server actions with friendly errors"
```

---

### Task 8: Worker de recepción: nombres en Odoo, referencia del picking, duplicados al enviar

**Files:**
- Modify: `lib/sync/recepcion.ts`, `lib/sync/recepcion.test.ts` (reescribir con PGlite)
- Modify: `lib/odoo/pickings.ts`, `lib/odoo/pickings.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5.
- Produces:
  - `checkDuplicateTrackingNumbers(trackingNumbers: string[]): Promise<Map<string, string>>` (tracking → nombre del picking donde ya está; fields `['lot_id','picking_id']`).
  - `syncRecepcionSession(sesionId: string): Promise<void>`, con estos cambios sobre el actual:
    - Usa `almacen.odooInTypeId`; si falta, `ConfiguracionError`. Si falta el `odooProductId` de un courier, también `ConfiguracionError`.
    - La lectura del picking pide `['location_id','location_dest_id','name']` y guarda `odooPickingRef` en la sesión.
    - Los duplicados en vivo quedan con `estado 'duplicado'`, `duplicadoAlEnviar: true` y `duplicadoRef` igual al picking de Odoo.
    - `recordSyncedTrackings` recibe `odooPickingRef`.
    - "Recibido por" (`ODOO_FIELD_RECIBIDO_POR`) lleva los nombres distintos de quienes escanearon, en el orden del primer escaneo y separados por `', '`. Si los paquetes no tienen operario (filas viejas), usa el operario de la sesión.
    - La nota del chatter dice `Registrado vía Webapp Paquetería por ${nombres}`.
    - Si sale bien: `ultimoErrorTipo = null` y auditoría `sync_ok` con `{ sesionId, odooPickingRef }`.

- [ ] **Step 1: Escribir los tests que fallan** (PGlite; `lib/odoo/pickings` y `odooCall` mockeados)

```ts
it('creates the picking with the almacén reception type and stores its reference', async () => {
  // almacén con odooInTypeId 1; odooCall(read) devuelve name 'MB92/IN/00231'
  await syncRecepcionSession(sesionId)
  expect(createIncomingPicking).toHaveBeenCalledWith(1, 673)
  expect(await sesion()).toMatchObject({ estado: 'sincronizada', odooPickingRef: 'MB92/IN/00231' })
})
it('writes the scanners names to Recibido por and the chatter, not UUIDs', async () => {
  process.env.ODOO_FIELD_RECIBIDO_POR = 'x_studio_recibido_por_2'
  // paquetes escaneados por Veronika y después por Eduardo
  await syncRecepcionSession(sesionId)
  expect(odooCall).toHaveBeenCalledWith('stock.picking', 'write', { ids: [501], vals: { x_studio_recibido_por_2: 'Veronika, Eduardo' } })
  expect(odooCall).toHaveBeenCalledWith('stock.picking', 'message_post', expect.objectContaining({ body: 'Registrado vía Webapp Paquetería por Veronika, Eduardo' }))
})
it('marks live duplicates as duplicadoAlEnviar with the Odoo reference and syncs the rest', ...)
it('throws ConfiguracionError when the almacén has no reception type', ...)
// Se conservan los casos actuales: no recrea el picking al reintentar, saltea tandas con move,
// nota cuando todo era duplicado, sesión vacía sin nota, error legible si el picking no existe.
```
`pickings.test.ts`: `checkDuplicateTrackingNumbers` devuelve `new Map([['ABC123','MB92/IN/00010']])`.

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/sync/recepcion.test.ts lib/odoo/pickings.test.ts` → FAIL.
- [ ] **Step 3: Implementar** según "Produces".
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/sync/recepcion.ts lib/sync/recepcion.test.ts lib/odoo/pickings.ts lib/odoo/pickings.test.ts
git commit -m "fix: write operario names and picking reference instead of UUIDs on reception sync"
```

---

### Task 9: Lectura de entregas pendientes con el tipo de operación correcto

**Files:**
- Modify: `lib/odoo/pickings.ts`, `lib/odoo/pickings.test.ts` (reemplaza `getPendingOutgoing`)
- Create: `lib/entrega/entregas.ts`, `lib/entrega/entregas.test.ts`
- Delete: `app/(app)/entrega/EntregaClient.tsx`, `app/(app)/entrega/SignaturePad.tsx`, `app/(app)/entrega/actions.ts` y `app/(app)/entrega/actions.test.ts`, porque usan `getPendingOutgoing`. Mientras tanto, `app/(app)/entrega/page.tsx` queda como un `<h1>Entrega</h1>` provisorio, que se reemplaza en la Task 15.

**Interfaces:**
- Consumes: Tasks 1-3, `contarSinEnviarPorBarco` (Task 6).
- Produces:
  - `interface BarcoConEntrega { barcoOdooId: number; barcoNombre: string; paquetes: number; desde: Date }`; `getBarcosConEntregaPendiente(outTypeId: number): Promise<BarcoConEntrega[]>` → una llamada a `stock.picking` `search_read`. Domain `[['picking_type_id','=',outTypeId],['state','not in',['draft','done','cancel']],[barcoField,'!=',false]]` y fields `[barcoField,'move_line_ids','create_date']`. Agrupa por barco: `paquetes` es la suma de `move_line_ids` y `desde` es la `create_date` más vieja. **Sin** `picking_type_code`.
  - `interface LineaEntrega { moveLineId: number; pickingId: number; pickingRef: string; trackingNumber: string | null; courierNombre: string }`; `getLineasEntregaPendiente(entrada: { outTypeId: number; barcoOdooId: number }): Promise<LineaEntrega[]>`. Hace dos lecturas:
    1. los pickings del barco, con el mismo domain que arriba más el barco;
    2. `stock.move.line` con `[['picking_id','in',ids]]` y fields `['picking_id','lot_id','product_id']`.
    Devuelve todas las líneas. Si `lot_id` es `false`, `trackingNumber` queda en `null`.
  - `interface BarcoParaEntregar { barcoOdooId: number; barcoNombre: string; paquetes: number; desde: Date | null; sinEnviar: number }`; `listarBarcosParaEntregar(almacen: Pick<Almacen, 'id' | 'odooOutTypeId'>): Promise<BarcoParaEntregar[]>`. Sin `odooOutTypeId` lanza `ConfiguracionError('El almacén no tiene tipo de entrega. Refrescá los datos de Odoo.')`. Suma los barcos que solo tienen paquetes sin enviar (`paquetes 0`, nombre de la cache). Ordena por `desde`; los barcos con `desde` nulo van al final.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
it('getBarcosConEntregaPendiente filters by the almacén delivery type and groups per barco', async () => {
  process.env.ODOO_FIELD_BARCO = 'x_studio_barco'
  vi.mocked(odooCall).mockResolvedValue([
    { id: 1, x_studio_barco: [673, 'MAYANQUEEN'], move_line_ids: [1, 2], create_date: '2026-10-14 08:00:00' },
    { id: 2, x_studio_barco: [673, 'MAYANQUEEN'], move_line_ids: [3], create_date: '2026-10-20 08:00:00' }])
  expect(await getBarcosConEntregaPendiente(2)).toEqual([
    { barcoOdooId: 673, barcoNombre: 'MAYANQUEEN', paquetes: 3, desde: new Date('2026-10-14T08:00:00Z') }])
  expect(vi.mocked(odooCall).mock.calls[0][2]).toMatchObject({ domain: expect.arrayContaining([['picking_type_id', '=', 2]]) })
  expect(JSON.stringify(vi.mocked(odooCall).mock.calls[0][2])).not.toContain('picking_type_code')
})
it('getLineasEntregaPendiente returns a line without lot as trackingNumber null', async () => {
  // move line { id: 9, picking_id: [1,'MB92/OUT/00487'], lot_id: false, product_id: [21,'UPS (incorrecto)'] }
  expect(lineas).toContainEqual({ moveLineId: 9, pickingId: 1, pickingRef: 'MB92/OUT/00487', trackingNumber: null, courierNombre: 'UPS (incorrecto)' })
})
it('listarBarcosParaEntregar adds barcos that only have unsent packages', ...)
it('listarBarcosParaEntregar marks sinEnviar from open recepciones', ...)
it('listarBarcosParaEntregar throws ConfiguracionError without a delivery type', ...)
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/odoo/pickings.test.ts lib/entrega` → FAIL.
- [ ] **Step 3: Implementar** según "Produces".
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/odoo/pickings.ts lib/odoo/pickings.test.ts lib/entrega "app/(app)/entrega/page.tsx"
git rm "app/(app)/entrega/EntregaClient.tsx" "app/(app)/entrega/SignaturePad.tsx" "app/(app)/entrega/actions.ts" "app/(app)/entrega/actions.test.ts"
git commit -m "fix: read pending deliveries with the almacén delivery operation type"
```

---

### Task 10: Confirmar entrega y worker (entrega parcial, nombre del crew, firma)

**Files:**
- Modify: `lib/odoo/pickings.ts`, `lib/odoo/pickings.test.ts`
- Modify: `lib/entrega/entregas.ts`, `lib/entrega/entregas.test.ts`
- Modify: `lib/sync/entrega.ts`, `lib/sync/entrega.test.ts` (reescribir con PGlite)

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 9.
- Produces:
  - `validarEntrega(entrada: { pickingId: number; moveLineIdsElegidas: number[] }): Promise<{ quedanEnDeposito: number }>`. Pasos:
    1. Lee los `move_line_ids` del picking.
    2. Escribe `picked: true` en las líneas elegidas y `picked: false` en el resto (si hay resto).
    3. Llama a `button_validate`. Si queda resto, con `context: { skip_backorder: true }` para que Odoo cree el backorder sin wizard; si no, sin contexto.
    4. Si Odoo devuelve un objeto (una acción o wizard) en lugar de `true`, lanza `RespuestaOdooInesperadaError(\`Odoo pidió confirmar (${res.res_model})\`)`.
  - `registrarEntrega(entrada: { id: string; operarioId: string; almacenId: number; barcoOdooId: number; pickingIds: number[]; moveLineIds: number[]; receptorNombre: string; firmaBase64: string }): Promise<void>`. Es idempotente por `id`:
    1. Recorta el nombre y le quita a la firma el prefijo `data:...;base64,`.
    2. Inserta con `onConflictDoNothing()`, en estado `confirmada_pendiente_sync` y con `confirmedAt`.
    3. Solo si insertó: `publishSync` y auditoría `entrega_confirmada`.
  - `interface EntregaDeHoy { id: string; barcoNombre: string; paquetes: number; receptorNombre: string; estado: 'enviando' | 'ok' | 'problema' }`; `listarEntregadasHoy(almacenId: number, ahora?: Date): Promise<EntregaDeHoy[]>`.
  - `syncEntregaSession(sesionId: string): Promise<void>`. Si falta `ODOO_FIELD_RECIBIDO_POR`, lanza `ConfiguracionError`. Para cada `pickingId`:
    1. Lee `['state','move_line_ids','is_signed']`. Las líneas elegidas son la intersección de esas líneas con `odooMoveLineIds`; si no hay ninguna, saltea el picking.
    2. Si el estado no es `done`, llama a `validarEntrega`.
    3. Si el picking no está firmado, escribe `{ signature: firma, [recibidoPorField]: receptorNombre }`. Esto va **después** de validar, para que el backorder no herede ni el nombre ni la firma.
    4. Si en esta corrida validó o firmó, deja en el chatter: `Entregado a ${receptor} vía Webapp Paquetería por ${operario}: ${n} paquete(s)` + `; ${m} quedan en depósito` cuando `m > 0`.

    Al final, la sesión pasa a `sincronizada` y se registra `sync_ok` en la auditoría.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// pickings.test.ts
it('validarEntrega picks only the chosen lines and validates with skip_backorder when some stay', async () => {
  vi.mocked(odooCall).mockResolvedValueOnce([{ id: 700, move_line_ids: [1, 2, 3] }]).mockResolvedValue(true)
  expect(await validarEntrega({ pickingId: 700, moveLineIdsElegidas: [1, 2] })).toEqual({ quedanEnDeposito: 1 })
  expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'write', { ids: [1, 2], vals: { picked: true } })
  expect(odooCall).toHaveBeenCalledWith('stock.move.line', 'write', { ids: [3], vals: { picked: false } })
  expect(odooCall).toHaveBeenCalledWith('stock.picking', 'button_validate', { ids: [700], context: { skip_backorder: true } })
})
it('validarEntrega validates plainly when every line is chosen', ...)
it('validarEntrega throws when Odoo answers with a wizard instead of true', ...)
```
```ts
// entregas.test.ts (PGlite)
it('registrarEntrega is idempotent by id: a retry after a dropped connection publishes once', async () => {
  const entrada = { id: crypto.randomUUID(), /* ... */ firmaBase64: 'data:image/png;base64,AAA' }
  await registrarEntrega(entrada); await registrarEntrega(entrada)
  expect(await db.select().from(sesionesEscaneo)).toHaveLength(1)
  expect(publishSync).toHaveBeenCalledTimes(1)
})
it('registrarEntrega stores the bare base64 and the trimmed crew name', ...)
it('listarEntregadasHoy shows who received and the estado', ...)
```
```ts
// sync/entrega.test.ts (PGlite; validarEntrega y odooCall mockeados)
it('validates only pickings with chosen lines, then writes signature and crew name', ...)
it('a retry after validation writes the missing signature without validating again', ...)
it('skips a picking already done and signed', ...)
it('the chatter note names the crew member and the packages left in depósito', ...)
it('throws ConfiguracionError when ODOO_FIELD_RECIBIDO_POR is unset', ...)
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/odoo/pickings.test.ts lib/entrega lib/sync/entrega.test.ts` → FAIL.
- [ ] **Step 3: Implementar** según "Produces".
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/odoo/pickings.ts lib/odoo/pickings.test.ts lib/entrega lib/sync/entrega.ts lib/sync/entrega.test.ts
git commit -m "feat: partial deliveries with backorder, crew name and signature after validation"
```

---

### Task 11: Pendientes (dominio, actions y pantalla)

**Files:**
- Modify: `lib/sync/pendientes.ts`, `lib/sync/pendientes.test.ts` (reescribir con PGlite)
- Rewrite: `app/(app)/pendientes/page.tsx`, `app/(app)/pendientes/actions.ts`; Create: `app/(app)/pendientes/actions.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 5, `haceCuanto` (Task 6), `ejecutarAccion` y `ResultadoAccion` (Task 7).
- Produces:
  - `MINUTOS_TRABADO = 15`; `type TipoProblema = 'error' | 'trabado' | 'duplicado'`; `type Alcance = { almacenIds: number[] } | 'todos'`.
  - `interface Problema { sesionId: string; tipo: TipoProblema; sesionTipo: 'recepcion' | 'entrega'; almacenPrefijo: string; barcoNombre: string; operarioNombre: string; fecha: Date; paquetes: Array<{ trackingNumber: string; ref: string | null }>; mensaje: string; detalle: string | null; loArreglaElAdmin: boolean }`.
  - `listarProblemas(alcance: Alcance, ahora?: Date): Promise<Problema[]>`. Incluye:
    - sesiones en `error`;
    - sesiones `confirmada_pendiente_sync` con `confirmedAt` anterior a `ahora − 15 min` (tipo `trabado`);
    - sesiones `sincronizada` con paquetes `duplicadoAlEnviar` (tipo `duplicado`).

    En los tres casos, solo las que tienen `revisadoAt` nulo.
  - Mensajes:
    - `error`: `mensajeProblema(ultimoErrorTipo ?? 'odoo')`;
    - `trabado`: "Lleva más de 15 minutos enviándose. Probá Reintentar.";
    - `duplicado`: "Estos paquetes ya estaban en Odoo y no se cargaron de nuevo. Revisá que no sea un error."

    `loArreglaElAdmin` es `ultimoErrorTipo === 'configuracion'`, y `detalle` es `ultimoError`.
  - `contarProblemas(alcance: Alcance, ahora?: Date): Promise<number>`.
  - `reintentar(entrada: { sesionId: string; operarioId: string }): Promise<void>`: pasa la sesión a `confirmada_pendiente_sync`, borra `revisadoAt`, llama a `publishSync` y registra `reintento` en la auditoría.
  - `marcarRevisado(entrada: { sesionId: string; operarioId: string }): Promise<void>`: setea `revisadoAt` y `revisadoPor`, y registra `revisado` en la auditoría.
  - `pendientes/actions.ts`: `reintentarAction(sesionId: string): Promise<ResultadoAccion>` y `marcarRevisadoAction(sesionId: string): Promise<ResultadoAccion>`. El admin puede todo; el operario, solo si tiene el almacén de la sesión. Las dos hacen `revalidatePath('/pendientes')`.
  - `pendientes/page.tsx`: usa las clases de la Task 12 (`.card`, `.btn`, etc.); hasta esa task se ven sin estilo, y eso está bien.
    - Una tarjeta por `Problema`, con tipo, barco, almacén, quién y `haceCuanto`.
    - Debajo, `mensaje` y los paquetes con su `ref`. Si `loArreglaElAdmin`, la etiqueta "Lo tiene que arreglar el admin".
    - Botones "Reintentar" (en `error` y `trabado`) y "Marcar como revisado" (en todos), más `<details>` "Ver detalle" con `detalle`.
    - Si no hay problemas: "No hay nada pendiente."

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// lib/sync/pendientes.test.ts (PGlite)
it('lists errors, stuck sends and sync-time duplicados, only in the operario almacenes', ...)
it('admin scope sees every almacén', ...)
it('scan-time duplicados are not problems', ...)          // duplicadoAlEnviar false
it('a reviewed session disappears', ...)
it('flags configuration errors for the admin', ...)
it('reintentar puts the session back in the queue and clears revisado', ...)
it('contarProblemas matches listarProblemas', ...)
// app/(app)/pendientes/actions.test.ts (auth y dominio mockeados)
it('reintentarAction refuses a session from an almacén the operario does not have', ...)
it('an admin can retry any session', ...)
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/sync/pendientes.test.ts "app/(app)/pendientes"` → FAIL.
- [ ] **Step 3: Implementar** según "Produces".
- [ ] **Step 4: Correr** → PASS. `npm run typecheck` → OK.
- [ ] **Step 5: Commit**

```bash
git add lib/sync/pendientes.ts lib/sync/pendientes.test.ts "app/(app)/pendientes"
git commit -m "feat: delegable pendientes with plain messages, stuck detection and review"
```

---

### Task 12: Estilos, estructura de la app, login, errores, manifest y entorno local seguro

**Files:**
- Rewrite: `app/globals.css`
- Modify: `app/layout.tsx` (export `viewport` con `themeColor: '#1d1d1f'`; body con la fuente Geist ya cargada), `app/page.tsx` (`redirect('/recepcion')`)
- Create: `components/app-shell.tsx`, `components/nav-tabs.tsx`, `components/almacen-switcher.tsx`; Delete: `components/nav-bar.tsx`
- Modify: `app/(app)/layout.tsx`, `app/admin/layout.tsx`
- Create: `app/(app)/error.tsx`, `app/admin/error.tsx`
- Modify: `app/(auth)/login/login-form.tsx`, `app/(auth)/login/page.tsx`
- Create: `app/manifest.ts`, `app/apple-icon.tsx`, `app/icon-192.png/route.tsx`, `app/icon-512.png/route.tsx`, `lib/ui/app-icon.tsx`

**Interfaces:**
- Consumes: `getAlmacenActivo`, `elegirAlmacenAction` (Task 7), `contarProblemas` (Task 11).
- Produces:
  - **Tokens CSS** (`:root`), sacados de los bocetos aprobados: `--bg #f5f5f7`, `--surface #ffffff`, `--text #1d1d1f`, `--text-2 #6e6e73`, `--text-3 #8e8e93`, `--border #e5e5ea`, `--border-strong #c7c7cc`, `--primary #0a7d32`, `--ok-bg #e3f6e8`, `--ok-text #0a5c26`, `--danger #a1170f`, `--danger-bg #fdeceb`, `--warn #b25f00`, `--warn-bg #fff4e0`, `--focus #0a5bd3`, `--radius 12px`, `--tap 48px`. No hay modo oscuro.
  - **Clases compartidas:** `.page`, `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-link`, `.chip` (con `[aria-pressed="true"]`), `.card`, `.list`, `.list-row`, `.banner`, `.banner-ok`, `.banner-error`, `.banner-warn`, `.input`, `.label`, `.mono`, `.badge`. Todo lo que se toca mide al menos `var(--tap)`.
  - `interface Tab { href: string; label: string; badge?: number }`. `AppShell({ tabs, almacenes, operarioNombre, children })` es un server component.
    - La cabecera muestra el almacén activo, el nombre del operario y "Cerrar sesión" (con el form de la action `logout` que ya existe).
    - Las pestañas van arriba en pantallas de 768px o más, y fijas abajo en las más chicas. `NavTabs` (client) marca la activa con `usePathname`.
    - `AlmacenSwitcher({ activoId, disponibles })` (client) solo aparece si hay más de un almacén; llama a `elegirAlmacenAction` (Task 7) y después a `router.refresh()`.
  - `(app)/layout.tsx`:
    - Pestañas Recepción, Entrega, Pendientes (con `badge` = `contarProblemas`, sobre los almacenes del operario o `'todos'` si es admin) y Admin para el admin.
    - El redirect a `/login` se mantiene como está.
  - `admin/layout.tsx`: pestañas "← Recepción", "Operarios" y "Datos de Odoo" (`/admin`).
  - `error.tsx`: `{ error, retry }` y el texto "Algo salió mal." con un botón "Reintentar".
  - `manifest.ts`: `name` y `short_name` 'Paquetería', `start_url: '/recepcion'`, `display: 'standalone'`, `background_color: '#ffffff'`, `theme_color: '#1d1d1f'` e íconos `/icon-192.png` (192x192) y `/icon-512.png` (512x512) PNG.
  - **Íconos:** con `ImageResponse` de `next/og`, a partir de un único componente `AppIcon({ size })` en `lib/ui/app-icon.tsx` (cuadrado oscuro redondeado con una caja dibujada con divs, sin emoji ni fuentes externas). `apple-icon.tsx` de 180x180.

- [ ] **Step 1: Leer la documentación de Next** usada en esta task: `01-app/01-getting-started/03-layouts-and-pages.md`, `10-error-handling.md`, `11-css.md`, `03-api-reference/03-file-conventions/error.md`, `01-metadata/manifest.md`, `01-metadata/app-icons.md`, `04-functions/image-response.md`, `generate-viewport.md`.

- [ ] **Step 2: Entorno local seguro (requiere OK del usuario).** Si se corre `npm run dev` con el `.env` actual, la app apunta a Neon de **producción** y QStash llama al deploy de producción, que escribe en Odoo. Antes de abrir la app en local:
  1. Crear una rama de Neon `dev-mejora-ui` desde `main` en el proyecto `plain-base-40271679`. Eso es una escritura en el proyecto Neon, así que necesita el OK del usuario.
  2. Crear `.env.local` (ya está ignorado por `.env*`) con el `DATABASE_URL` de esa rama y `QSTASH_TOKEN=deshabilitado-en-local`. Así "Enviar a Odoo" falla de forma segura en local, con el mensaje de error.
  3. Aplicar en esa rama el SQL de limpieza y `db/migrations/0001_mejora_ui.sql`.

  Las lecturas de Odoo (lista de entregas) sí van a producción; son de solo lectura y están permitidas.

- [ ] **Step 3: Implementar** estilos, shell, login, errores, manifest e íconos según "Produces".

- [ ] **Step 4: Verificar**
  - Run: `npm run typecheck` y `npm test` → todo en verde.
  - Run: `npm run dev`, con `.env.local` puesto. Chequear:
    - `/login` se ve con el estilo nuevo;
    - después de entrar, las pestañas aparecen arriba en una ventana ancha y abajo en una de 390px;
    - el selector de almacén solo aparece con más de un almacén;
    - `/manifest.webmanifest` responde el JSON;
    - `/icon-192.png`, `/icon-512.png` y `/apple-icon` responden `image/png`.

- [ ] **Step 5: Commit**

```bash
git add app/globals.css app/layout.tsx app/page.tsx components "app/(app)/layout.tsx" "app/(app)/error.tsx" app/admin/layout.tsx app/admin/error.tsx "app/(auth)/login" app/manifest.ts app/apple-icon.tsx app/icon-192.png app/icon-512.png lib/ui/app-icon.tsx
git rm components/nav-bar.tsx
git commit -m "feat: new visual shell, tabs, active almacén switcher, manifest and icons"
```

---

### Task 13: Pantalla de recepción de un barco (pistola, couriers, cola de escaneos)

**Files:**
- Create: `lib/ui/cola-escaneo.ts`, `lib/ui/cola-escaneo.test.ts`
- Create: `lib/ui/sonidos.ts`, `lib/ui/foco.ts`
- Create: `lib/recepcion/couriers.ts`, `lib/recepcion/couriers.test.ts`
- Create: `components/scan-input.tsx`, `components/courier-picker.tsx`
- Create: `app/(app)/recepcion/[sesionId]/page.tsx`, `app/(app)/recepcion/[sesionId]/RecepcionBarco.tsx`

**Interfaces:**
- Consumes: Tasks 6, 7, 12.
- Produces:
  - `lib/ui/cola-escaneo.ts`:
    - `interface FilaEscaneo { clave: string; trackingNumber: string; courierId: number; courierNombre: string; estado: 'verificando' | 'ok' | 'duplicado' | 'error'; detalle: string | null; itemId: string | null }`
    - `type AccionCola = { tipo: 'escaneado'; clave: string; trackingNumber: string; courierId: number; courierNombre: string } | { tipo: 'resuelto'; clave: string; resultado: ResultadoEscaneo } | { tipo: 'fallido'; clave: string; mensaje: string } | { tipo: 'borrado'; itemId: string }`
    - `colaReducer(filas: FilaEscaneo[], accion: AccionCola): FilaEscaneo[]`: la fila más nueva arriba. `resuelto` con `repetido` **quita** la fila provisoria (el aviso lo muestra la pantalla).
    - `filasIniciales(paquetes: PaqueteEscaneado[]): FilaEscaneo[]`
    - `normalizarCodigo(crudo: string): string | null`
  - `lib/ui/foco.ts`: `noRobarFoco(e: React.PointerEvent): void` (hace `preventDefault()` en `pointerdown`, para que tocar un botón no le quite el foco al campo de escaneo).
  - `lib/ui/sonidos.ts`: `sonarOk(): void`, `sonarAviso(): void` (Web Audio, `AudioContext` creado en el primer toque; si falla, silencio).
  - `lib/recepcion/couriers.ts`: `COURIERS_FRECUENTES = 10`; `interface CourierOpcion { id: number; nombre: string }`; `getCouriersParaRecepcion(almacenId: number): Promise<{ frecuentes: CourierOpcion[]; todos: CourierOpcion[] }>`. Solo couriers activos. `frecuentes` son los 10 con más `usos` en ese almacén; si ninguno tiene uso, los 10 primeros por nombre. `todos` va ordenado por nombre.
  - `ScanInput` (client) acepta `ref` (React 19, sin `forwardRef`) y expone `{ enfocar(): void }`. Props: `{ onCodigo: (codigo: string) => void; deshabilitado?: boolean }`.
    - Usa `inputMode="none"`. Con Enter hace `preventDefault`, toma el valor, limpia el campo **en el mismo evento** y llama a `onCodigo`.
    - El botón "Escribir a mano" cambia a `inputMode="text"` para un solo código y vuelve a `none` después del Enter.
    - Recupera el foco con `pointerup` en cualquier parte de la pantalla, salvo que el destino sea otro `input`, `textarea` o `select`.
  - `CourierPicker` (client), props `{ frecuentes: CourierOpcion[]; todos: CourierOpcion[]; elegidoId: number | null; onElegir: (c: CourierOpcion) => void }`. Los frecuentes son chips con `aria-pressed`. "Otro courier…" abre una lista con filtro. Todos los botones usan `onPointerDown={noRobarFoco}`.
  - `RecepcionBarco` (client), props `{ recepcion: RecepcionDetalle; couriers: { frecuentes: CourierOpcion[]; todos: CourierOpcion[] } }`. Muestra, en este orden:
    - la cabecera del boceto;
    - el `CourierPicker`. El último usado se recuerda en `localStorage['paqueteria:ultimoCourier']`, con `try/catch`; si no hay, se marca el primer frecuente;
    - el `ScanInput`;
    - la franja de respuesta: verde "✓ {código} · {courier} — agregado", roja "Duplicado: ya está en {ref} · no se envía" o roja "Ya está en {donde}";
    - la lista de paquetes con ✕;
    - los botones "Dejar abierta", "Enviar a Odoo · N paquetes" y "Descartar recepción" (link, con `confirm()`). "Dejar abierta" vuelve a `/recepcion`; si la recepción no tiene paquetes, antes llama a `descartarRecepcionAction`, y así las vacías se limpian solas.

    Cada código sigue este flujo: `clave = crypto.randomUUID()` → `escaneado` → `await escanearAction(...)` → `resuelto` o `fallido` → franja + sonido.

    Mientras corre su action (`useTransition`), cada botón de acción queda deshabilitado, así un doble toque no la repite. El campo de escaneo **no** se deshabilita: los escaneos se encolan.
  - `page.tsx` (server): si `getRecepcion` devuelve `null`, `notFound()`. Si la recepción ya no está `en_curso`, muestra solo lectura ("Esta recepción ya se envió.") con un link a `/recepcion`.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// lib/ui/cola-escaneo.test.ts
it('keeps every rapid scan as its own row while earlier ones are still verifying', () => {
  let f = colaReducer([], esc('a', 'T1')); f = colaReducer(f, esc('b', 'T2')); f = colaReducer(f, esc('c', 'T3'))
  f = colaReducer(f, { tipo: 'resuelto', clave: 'b', resultado: agregado('T2', 'i2') })
  expect(f.map((x) => [x.trackingNumber, x.estado])).toEqual([['T3', 'verificando'], ['T2', 'ok'], ['T1', 'verificando']])
})
it('a repetido result removes the provisional row', ...)
it('marks an agregado duplicado row with its Odoo reference', ...)
it('a failed scan stays with its error so it can be scanned again', ...)
it('borrado removes the row of that item', ...)
it('normalizarCodigo trims and rejects empty codes', () => {
  expect(normalizarCodigo('  JJD1 \n')).toBe('JJD1'); expect(normalizarCodigo('   ')).toBeNull()
})
```
```ts
// lib/recepcion/couriers.test.ts (PGlite)
it('frecuentes are the most used couriers of the almacén, inactive ones excluded', ...)
it('falls back to the first ten by name when there is no usage yet', ...)
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/ui lib/recepcion/couriers.test.ts` → FAIL.
- [ ] **Step 3: Implementar** lógica, componentes y pantalla. Antes, leer `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` y `02-guides/forms.md`.
- [ ] **Step 4: Correr** los tests → PASS. `npm run typecheck` → OK.
- [ ] **Step 5: Verificación manual** (`npm run dev` con `.env.local`, ventana de tablet de 1024x768):
  - Abrir una recepción de prueba. Escribir un código en el campo y apretar Enter rápido tres veces con códigos distintos: aparecen tres filas en orden.
  - Tocar un courier y volver a "escanear" con el teclado: el foco sigue en el campo y el Enter **no** activa ningún botón.
  - Repetir un código: franja roja "Ya está en esta recepción".
  - "Escribir a mano" abre el teclado (en Chrome DevTools, modo táctil).
  - "Enviar a Odoo" en local da el error de QStash deshabilitado y la recepción queda abierta.
- [ ] **Step 6: Commit**

```bash
git add lib/ui lib/recepcion/couriers.ts lib/recepcion/couriers.test.ts components/scan-input.tsx components/courier-picker.tsx "app/(app)/recepcion/[sesionId]"
git commit -m "feat: reception screen for a barco with scanner-safe focus and scan queue"
```

---

### Task 14: Inicio de recepción (buscador, abiertas, enviadas hoy, escanear sin barco)

**Files:**
- Create: `components/barco-search.tsx`
- Rewrite: `app/(app)/recepcion/page.tsx` (hoy provisorio, desde la Task 7)
- Create: `app/(app)/recepcion/RecepcionHome.tsx`

**Interfaces:**
- Consumes: Tasks 3, 6, 7, 12, 13.
- Produces:
  - `BarcoSearch` (client), props `{ onElegir: (b: BarcoOpcion) => void; placeholder: string; autoFocus?: boolean }`. Busca desde 2 letras, con 200 ms de espera, usando `searchBarcosAction`. Descarta respuestas viejas con un contador de pedidos. Cada resultado es un botón grande con `etiqueta`.
  - `page.tsx` (server): lee el almacén activo con `requireAlmacenActivo` (sin almacenes muestra el mensaje en un `.banner-warn`), `listarRecepcionesAbiertas`, `listarEnviadasHoy` y `getCouriersParaRecepcion`, y renderiza `RecepcionHome`.
  - `RecepcionHome` (client), props `{ abiertas: RecepcionAbierta[]; enviadas: RecepcionEnviada[]; couriers: { frecuentes: CourierOpcion[]; todos: CourierOpcion[] } }`. Tiene:
    - `BarcoSearch` ("Buscar barco para empezar una recepción…") → `abrirRecepcionAction` → `router.push('/recepcion/' + id)`;
    - "Recepciones abiertas · N": filas con nombre, `porCourier` y `haceCuanto`. Si llevan más de 24 h abiertas, el tiempo va en `.banner-warn`;
    - el botón "Enviar las N a Odoo · M paquetes" (solo si N > 0) → `enviarTodasAction` → `router.refresh()`;
    - "Enviadas hoy": "enviando…" en ámbar, "✓ {ref}" en verde y "⚠ problema" en rojo, que lleva a `/pendientes`;
    - un `ScanInput` oculto pero activo. Si llega un código, abre el diálogo "¿Para qué barco es?" con `BarcoSearch` y `CourierPicker` (con el último usado marcado) y el código retenido. Al elegir el barco llama a `asignarYEscanearAction` y después a `router.push('/recepcion/' + sesionId)`.

    Mientras corre su action, cada botón queda deshabilitado (`useTransition`).

- [ ] **Step 1: Implementar** según "Produces". No hay tests unitarios nuevos: la lógica está en las tasks 6, 7 y 13.
- [ ] **Step 2: Verificar**
  - Run: `npm run typecheck` → OK. `npm test` → verde.
  - Manual (`npm run dev` con `.env.local`):
    - buscar "h3" muestra las etiquetas con `#id` (si en la rama de dev siguen los duplicados);
    - abrir dos barcos y dejarlos abiertos: el inicio los lista con sus couriers;
    - "escanear" en el inicio abre "¿Para qué barco es?" y, al elegir, lleva a la recepción con el paquete agregado;
    - recargar la página no pierde nada.
- [ ] **Step 3: Commit**

```bash
git add components/barco-search.tsx "app/(app)/recepcion/page.tsx" "app/(app)/recepcion/RecepcionHome.tsx"
git commit -m "feat: reception home with open receptions, sent today and scan-without-barco"
```

---

### Task 15: Pantallas de entrega en el móvil

**Files:**
- Create: `components/signature-pad.tsx`
- Create: `lib/ui/seleccion-entrega.ts`, `lib/ui/seleccion-entrega.test.ts`
- Rewrite: `app/(app)/entrega/page.tsx` (hoy provisorio); Create: `app/(app)/entrega/ListaBarcos.tsx`
- Create: `app/(app)/entrega/[barcoOdooId]/page.tsx`, `app/(app)/entrega/[barcoOdooId]/EntregaFlow.tsx`
- Create: `app/(app)/entrega/actions.ts`, `app/(app)/entrega/actions.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 7, 9, 10, 12.
- Produces:
  - `lib/ui/seleccion-entrega.ts`: `resumenSeleccion(lineas: LineaEntrega[], elegidas: ReadonlySet<number>): { total: number; elegidas: number; pickingIds: number[]; moveLineIds: number[] }` (los `pickingIds` son los de las líneas elegidas, sin repetir).
  - `SignaturePad` (client), props `{ onChange: (dataUrl: string | null) => void; alto?: number }`. Ocupa el ancho del contenedor (`ResizeObserver`) y escala por `devicePixelRatio`. Trazo de 2.5px con puntas redondeadas y Pointer Events con `touch-action: none`. Cuando terminás un trazo emite el PNG; "Borrar" emite `null`.
  - `entrega/actions.ts`:
    - `confirmarEntregaAction(entrada: { id: string; barcoOdooId: number; pickingIds: number[]; moveLineIds: number[]; receptorNombre: string; firmaDataUrl: string }): Promise<ResultadoAccion>` usa el almacén activo. Valida:
      - nombre recortado no vacío y de hasta 80 caracteres ("Falta el nombre de quien recibe.");
      - al menos una línea ("Elegí al menos un paquete.");
      - firma ("Falta la firma.").

      Después llama a `registrarEntrega` y a `revalidatePath('/entrega')`.
    - `enviarRecepcionesDelBarcoAction(barcoOdooId: number): Promise<ResultadoAccion<{ enviadas: number }>>` llama a `enviarRecepcionesAbiertas` con ese barco.
  - Paso 1, `entrega/page.tsx` (server):
    - Lee el almacén activo y `listarBarcosParaEntregar` y `listarEntregadasHoy`. Si `ConfiguracionError` o Odoo falla, muestra un `.banner-error` con el mensaje y un link "Reintentar" a la misma página.
    - `ListaBarcos` (client) filtra la lista localmente. Cada fila muestra nombre, cantidad y `desde`, con "+N sin enviar a Odoo" en `.banner-warn` si corresponde, y lleva a `/entrega/{barcoOdooId}`.
  - Pasos 2 y 3, `[barcoOdooId]/page.tsx` (server): lee `getLineasEntregaPendiente`, la cantidad sin enviar y el nombre del barco, y renderiza `EntregaFlow`.
  - `EntregaFlow` (client):
    - Estado: `paso` (`'paquetes'`, `'firma'` o `'hecho'`), `elegidas: Set<number>` (todas al principio), `receptor`, `firma`, `enviando`, `error` e `id`, que se crea una sola vez con `useState(() => crypto.randomUUID())`.
    - En el paso "paquetes", las líneas sin número se muestran como `{courier} · sin número`. Si hay paquetes sin enviar, aparece la franja "Hay N paquetes de este barco recibidos pero sin enviar a Odoo" con el botón "Enviar ahora".
    - En el paso "firma" se ven el resumen, el nombre y la firma.
    - Si `confirmarEntregaAction` devuelve error o la llamada falla por la red, **no se borra nada**: se muestra el error con "Reintentar", que reenvía con el mismo `id`.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// lib/ui/seleccion-entrega.test.ts
it('summarises chosen lines and the pickings they belong to', () => {
  const lineas = [l(1, 700), l(2, 700), l(3, 701)]
  expect(resumenSeleccion(lineas, new Set([1, 3]))).toEqual({ total: 3, elegidas: 2, pickingIds: [700, 701], moveLineIds: [1, 3] })
})
```
```ts
// app/(app)/entrega/actions.test.ts (auth, almacén activo y dominio mockeados)
it('rejects an empty crew name', ...)
it('rejects a confirmation without packages', ...)
it('rejects a confirmation without signature', ...)
it('passes the request to registrarEntrega with the active almacén', ...)
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run lib/ui/seleccion-entrega.test.ts "app/(app)/entrega"` → FAIL.
- [ ] **Step 3: Implementar** según "Produces".
- [ ] **Step 4: Correr** → PASS. `npm run typecheck` → OK.
- [ ] **Step 5: Verificación manual** (`npm run dev` con `.env.local`, ventana de 390x844 en modo táctil):
  - El paso 1 lista barcos reales de MB92 (es una lectura de Odoo de producción, solo lectura).
  - En el paso 2 se desmarca un paquete y el contador baja.
  - En el paso 3, la firma se ve nítida y "Borrar" la limpia.
  - "Confirmar entrega" en local falla por QStash deshabilitado y la pantalla conserva nombre, firma y selección; "Reintentar" muestra el mismo error sin duplicar nada en la base (verificar en la rama de Neon que hay **una** sola sesión de entrega con ese id).
  - Después, borrar esa sesión de prueba de la rama de dev.
- [ ] **Step 6: Commit**

```bash
git add components/signature-pad.tsx lib/ui/seleccion-entrega.ts lib/ui/seleccion-entrega.test.ts "app/(app)/entrega"
git commit -m "feat: three-step phone delivery with partial selection, crew name and signature"
```

---

### Task 16: Admin: datos de Odoo y operarios

**Files:**
- Rewrite: `app/admin/page.tsx` ("Datos de Odoo"), `app/admin/actions.ts`; Create: `app/admin/actions.test.ts`
- Modify: `app/admin/operarios/page.tsx`, `app/admin/operarios/actions.ts`, `lib/admin/operarios.ts`, `lib/admin/operarios.test.ts`
- Modify: `app/admin/operarios/[id]/almacenes/page.tsx`, `app/admin/operarios/[id]/almacenes/actions.ts`
- Delete: `app/admin/mapeos/page.tsx`, `app/admin/mapeos/actions.ts`, `lib/admin/odooMappings.ts`, `lib/admin/odooMappings.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 6 (`haceCuanto`), 7, 12.
- Produces:
  - `admin/actions.ts`: `refrescarDatosOdooAction(): Promise<ResultadoAccion>` llama a `publishRefreshMaestros()` y a `publishRefreshTrackings()` y registra `admin_refresco` en la auditoría.
  - `admin/page.tsx` ("Datos de Odoo"): muestra el último refresco (`ultimoRefresco`, con `haceCuanto`), cuántos almacenes y couriers activos hay y el botón "Refrescar ahora". Después de tocarlo aparece "Encolado. Tarda uno o dos minutos."
  - `lib/admin/operarios.ts`: `listOperariosConAlmacenes(): Promise<Array<Operario & { almacenes: string[] }>>` (prefijos de almacenes activos). La pantalla de operarios los muestra, y las altas, cambios de activo y de almacenes se registran en la auditoría.
  - `operarios/[id]/almacenes/page.tsx`: lista solo los almacenes activos.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// app/admin/actions.test.ts
it('refrescarDatosOdooAction enqueues both refresh jobs and audits it', ...)
// lib/admin/operarios.test.ts (PGlite)
it('listOperariosConAlmacenes returns the active almacén prefixes per operario', ...)
```

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run app/admin lib/admin` → FAIL.
- [ ] **Step 3: Implementar** según "Produces" y borrar Mapeos.
- [ ] **Step 4: Correr** → PASS. `npm run typecheck` y `npm test` → todo en verde. `grep -rn "odooPickingTypeId\|publishRefreshBarcos\|isKnownDuplicate\|getPendingOutgoing" app lib` → sin resultados.
- [ ] **Step 5: Commit**

```bash
git add app/admin lib/admin
git rm app/admin/mapeos/page.tsx app/admin/mapeos/actions.ts lib/admin/odooMappings.ts lib/admin/odooMappings.test.ts
git commit -m "feat: admin Odoo data refresh and operarios with their almacenes"
```

---

### Task 17: Puesta en producción y QA con dispositivos reales

**Files:**
- Create: `docs/superpowers/runbooks/2026-10-22-qa-mejora-ui.md`

Cada paso que escribe en producción necesita el OK del usuario **en ese momento**.

- [ ] **Step 1: Verificación completa en local**
  - Run: `npm test` → todo PASS.
  - Run: `npm run typecheck` → sin errores.
  - Run: `npm run build` → build OK.

- [ ] **Step 2: Neon de producción (con OK del usuario).**
  1. Correr `db/maintenance/2026-10-22-descartar-sesiones-de-prueba.sql`. Después, `SELECT count(*) FROM sesiones_escaneo WHERE estado = 'en_curso'` tiene que dar `0`.
  2. Aplicar las sentencias de `db/migrations/0001_mejora_ui.sql` en orden, en una transacción (Neon `run_sql_transaction`). **No** usar `drizzle-kit push`: la base de producción se creó con push, no tiene tabla de migraciones, y push pregunta de forma interactiva al agregar constraints únicos.
  3. Verificar que existen `courier_uso`, `sesiones_recepcion_abierta_unica` y `almacenes.odoo_out_type_id`.

- [ ] **Step 3: Deploy (con OK del usuario).**
  - `vercel --prod` desde local.
  - Comparar la fecha del deploy activo (`vercel inspect <url>`) con la del último commit: el deploy tiene que ser posterior.
  - Las variables de entorno no cambian. `ODOO_FIELD_RECIBIDO_POR` tiene que ser `x_studio_recibido_por_2`.

- [ ] **Step 4: Primer refresco de datos de Odoo.** En `/admin`, tocar "Refrescar ahora" y esperar unos dos minutos. Verificar en Neon:
  - 8 almacenes activos; MLC queda inactivo;
  - MB92 con `odoo_out_type_id = 2`;
  - unos 70 couriers activos; el 11 se llama "DHL" y el 21 queda inactivo;
  - `courier_uso` con filas;
  - `tracking_activos_cache` con más de 4 filas;
  - las asignaciones de Eduardo (MB92, MPV) y Veronika (MB92) intactas.

- [ ] **Step 5: Escribir el runbook de QA** `docs/superpowers/runbooks/2026-10-22-qa-mejora-ui.md` con el checklist de §10 del spec y estos chequeos (todos con el **barco de QA** y tandas chicas):
  - **Tablet con la pistola Bluetooth:**
    - 10 escaneos seguidos y rápidos: aparecen 10 filas en orden;
    - el Enter nunca activa un botón;
    - el campo de escaneo no abre el teclado en pantalla, pero el buscador de barcos y "Escribir a mano" sí;
    - un código con guion se guarda con guion.
  - **Recepción real de 2-3 paquetes con dos couriers:**
    - en Odoo, el picking queda `done`, con "Recibido por" = nombre del operario y la nota en el chatter;
    - el producto de cada courier es el correcto;
    - la entrega encadenada se genera;
    - en la app, "Enviadas hoy" muestra la referencia.
  - **Móvil:**
    - entrega parcial (dejar uno en depósito);
    - en Odoo, firma y "Recibido por" con el nombre del crew;
    - el backorder tiene exactamente el paquete que quedó, el barco, y no tiene firma ni nombre;
    - el albarán impreso muestra la firma y el nombre;
    - después, la entrega completa del backorder.
  - **Cortar los datos del móvil al confirmar:** la pantalla conserva todo, y al reintentar con datos queda una sola entrega.
  - **Pendientes:**
    - forzar un error de configuración que no toque Odoo: vaciar en Neon el `odoo_out_type_id` de un almacén de QA sin operarios reales, o probar un caso equivalente que acuerde el usuario;
    - verificar que aparece con "Lo tiene que arreglar el admin" y que la cola sigue procesando otras sesiones;
    - restaurar el dato.

- [ ] **Step 6: Correr el QA con el usuario.** Anotar los resultados en el runbook y corregir lo que falle. Cada fix lleva su test y su commit.

- [ ] **Step 7: Commit y cierre**

```bash
git add docs/superpowers/runbooks/2026-10-22-qa-mejora-ui.md
git commit -m "docs: QA runbook for the UI improvement rollout"
```
Preguntarle al usuario si se mergea `mejora-ui-revision` a `main`, y avisarle que `db/seed.ts` quedó obsoleto para almacenes y couriers (ahora vienen de Odoo). Ese archivo tiene cambios suyos sin commitear, así que no se toca.
