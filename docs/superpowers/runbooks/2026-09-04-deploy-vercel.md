# Runbook: primer deploy a Vercel — webapp-paquetería (Fase 1)

**Fecha:** 2026-09-04
**App:** Next.js 16.3.4 (App Router, Turbopack) + React 19.2, Drizzle + Neon, Upstash QStash.
**Estado de partida:** todo el código (22 tareas) commiteado en `master`; 70 tests en verde; `next build` OK.
**Nunca se ha desplegado:** sin git remote, sin proyecto Vercel.
**Plataforma local:** Windows. Los comandos van en **PowerShell** salvo que se indique **git-bash** (para `openssl` y aquí-documentos).

> ⚠️ **Reglas no negociables (memoria del proyecto)**
> - Odoo admite **≤ 1 petición/segundo GLOBAL**. Esto SOLO lo garantiza la cola QStash `odoo-sync` con `parallelism: 1`. Verificarlo (paso 3).
> - **Todas** las escrituras a Odoo pasan por la cola. El worker QStash es el ÚNICO que llama a Odoo (salvo 2 lecturas one-off).
> - **Solo base Odoo TEST** hasta que se indique lo contrario. `ODOO_BASE_URL` NUNCA apunta a producción en este deploy.
> - Nunca `unlink()` en Odoo. Operaciones idempotentes y logueadas.

---

## Resumen del flujo (por qué el orden importa)

1. Requisitos → 2. Crear/linkear proyecto → 3. Provisionar QStash → 4. Cargar env vars → 5. Primer deploy → 6. Fijar `APP_BASE_URL` a la URL real y **redeploy** → 7. Verificar DB → 8. Sembrar admin → 9. Verificación post-deploy → 10. Rollback si algo falla.

El **paso 6 es obligatorio**: QStash encola los jobs con `url: ${APP_BASE_URL}/api/qstash/...`. Si `APP_BASE_URL` no es la URL de producción, los jobs se publican pero el callback nunca llega a la app y **nada se sincroniza con Odoo**.

---

## Paso 1 — Requisitos

La CLI de Vercel **no está instalada**. Instalar y autenticar:

```powershell
npm i -g vercel
vercel --version
vercel login
```

`vercel login` abre el navegador. Elegir el mismo scope/equipo donde vivirá el proyecto.

Comprobar Node (Vercel usa Node 22.x por defecto; local hay v24, sirve para build):

```powershell
node -v
```

---

## Paso 2 — Crear y linkear el proyecto Vercel

Desde la raíz del repo (`Paquetes - Odoo`):

```powershell
vercel link
```

Responder:
- **Set up ... ?** → `y`
- **Which scope?** → tu equipo
- **Link to existing project?** → `N` (no existe)
- **Project name** → `webapp-paqueteria` (o el que prefieras; será parte de la URL)
- **In which directory is your code located?** → `./`
- **Framework** → se autodetecta **Next.js**. Aceptar los defaults de build (`next build`, output `.next`).

Esto crea `.vercel/` (Vercel lo añade solo a `.gitignore`).

**Rama:** el proyecto está en `master`, no `main`. Con deploy por CLI (`vercel --prod`) la rama es irrelevante: sube los archivos locales. Si más adelante conectás un repo Git:

```powershell
# opcional, solo si creás un remoto GitHub y querés deploys automáticos
vercel git connect
```

Y en **Vercel → Project → Settings → Git → Production Branch** poné `master` (el default es `main`).

---

## Paso 3 — Provisionar Upstash QStash

Se necesitan 3 secretos: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`.
La cola `odoo-sync` **no se crea a mano**: `lib/queue/publish.ts` llama `queue.upsert({ parallelism: 1 })` en cada publish, así que se autocrea con el parallelism correcto en el primer job.

### Opción A (recomendada) — integración Vercel Marketplace

```powershell
vercel integration add upstash
```

Sigue el flujo del navegador: crea/enlaza una cuenta Upstash y **añade automáticamente las env vars de QStash al proyecto** (normalmente en los 3 entornos). Al terminar:

```powershell
vercel env ls
```

Confirmá que aparecen `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`. Si la integración las nombró distinto o solo las puso en Preview/Development, copialas a Production a mano (paso 4).

### Opción B (manual) — consola de Upstash

1. Entrar a <https://console.upstash.com/qstash>.
2. Pestaña **QStash → Details**: copiar **QSTASH_TOKEN**.
3. Sección **Signing keys**: copiar **Current** y **Next** signing keys.
4. Cargarlas con `vercel env add` (paso 4).

### Verificar `parallelism = 1` (crítico de seguridad)

La cola aparece recién **después del primer publish**. Para forzarla ya:

```powershell
# tras el paso 5/6, logueado como admin, pulsar "Refrescar barcos ahora" en /admin
# o publicar un job de prueba con el token:
curl -X POST "https://qstash.upstash.io/v2/enqueue/odoo-sync/https://example.com/noop" -H "Authorization: Bearer $QSTASH_TOKEN"
```

Después, en **Upstash Console → QStash → Queues → `odoo-sync`**: el campo **Parallelism** debe decir **1**.
Si por lo que sea aparece con otro valor, el propio código lo corrige en el siguiente publish (`queue.upsert({ parallelism: 1 })`), pero **no desplegar tráfico real hasta confirmar que es 1**: con parallelism > 1 se violan las ≤ 1 req/s de Odoo.

---

## Paso 4 — Cargar todas las variables de entorno (Production)

Fuente de la verdad: `.env.example`. **No leer `.env`** (gitignored, secreto) — sus valores reales ya existen en la máquina local para las vars marcadas "SÍ" abajo.

Patrón por variable (pide el valor de forma interactiva):

```powershell
vercel env add NOMBRE production
```

O sin prompt, desde **git-bash**:

```bash
printf '%s' 'EL_VALOR' | vercel env add NOMBRE production
```

Cargá una por una:

| Variable | Valor / de dónde sale | ¿Ya conocido? |
| --- | --- | --- |
| `DATABASE_URL` | Connection string de Neon, proyecto `webapp-paqueteria` (`plain-base-40271679`), org `org-noisy-surf-59692630`, region `aws-eu-central-1`, pg17. Neon Console → Connect, **misma rama** donde ya se hizo push del schema. Valor real ya en `.env` local. | **Sí** |
| `ODOO_BASE_URL` | URL de la instancia **Odoo TEST** (SaaS `https://<algo>.odoo.com`). **Placeholder** en `.env`. NUNCA la de producción. | **No** — confirmar la URL test |
| `ODOO_API_KEY` | Odoo → Preferencias → Seguridad de la cuenta → API Keys. Valor real existe local. | **Sí** |
| `ODOO_FIELD_BARCO` | Nombre del campo Studio (Many2one → `project.project`) en `stock.picking`. Valor: **`x_studio_barco`** (sin `_4`) — decisión ya confirmada por el usuario el 2026-09-03; `CONTEXTO-ODOO-WEBAPP.md` §4 lista `x_studio_barco_4` como test pero se descartó. Ya en `.env` local. | **Sí** |
| `ODOO_FIELD_RECIBIDO_POR` | Campo texto "Recibido por". `x_studio_recibido_por`. Valor real existe local. | **Sí** |
| `QSTASH_TOKEN` | Paso 3 (integración o consola Upstash). | **No** |
| `QSTASH_CURRENT_SIGNING_KEY` | Paso 3 — Upstash → QStash → Signing keys → Current. | **No** |
| `QSTASH_NEXT_SIGNING_KEY` | Paso 3 — Upstash → QStash → Signing keys → Next. | **No** |
| `QSTASH_QUEUE_NAME` | Constante: `odoo-sync`. | **Sí** |
| `APP_BASE_URL` | URL de producción de Vercel. **Se conoce recién tras el paso 5.** Placeholder ahora; se fija en el paso 6. | **No** (huevo-gallina) |
| `SESSION_COOKIE_NAME` | Constante: `paqueteria_session`. | **Sí** |
| `CRON_SECRET` | Secreto aleatorio nuevo (ver abajo). Vercel Cron lo manda solo como `Authorization: Bearer $CRON_SECRET` a `/api/cron/refresh-caches`. | **No** — generar |

### Generar `CRON_SECRET`

git-bash:

```bash
openssl rand -hex 32
```

o PowerShell (sin openssl):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Cargarlo:

```powershell
vercel env add CRON_SECRET production
```

### Para `APP_BASE_URL` ahora, poné un placeholder (se corrige en paso 6):

```bash
printf '%s' 'https://placeholder.vercel.app' | vercel env add APP_BASE_URL production
```

### Comprobar

```powershell
vercel env ls
```

Deben estar las **12** variables en `production`.

---

## Paso 5 — Primer deploy a producción

```powershell
vercel --prod
```

Anotá la URL que devuelve (ej. `https://webapp-paqueteria.vercel.app` y/o `https://webapp-paqueteria-<hash>-<scope>.vercel.app`). Usá el **dominio estable** (`https://webapp-paqueteria.vercel.app`) como `APP_BASE_URL`.

**Esperado en este punto:**
- `/login` y la navegación cargan.
- Cualquier flujo que **encole a QStash** (confirmar una sesión de recepción/entrega, "Refrescar barcos ahora", el cron) **fallará o quedará sin sincronizar**, porque `APP_BASE_URL` todavía es el placeholder. Se arregla en el paso 6.

---

## Paso 6 — Fijar `APP_BASE_URL` a la URL real y redeploy

```powershell
vercel env rm APP_BASE_URL production
```

git-bash:

```bash
printf '%s' 'https://webapp-paqueteria.vercel.app' | vercel env add APP_BASE_URL production
```

Redeploy (las env vars se toman en build/deploy time):

```powershell
vercel --prod
```

**Por qué:** `lib/queue/publish.ts` hace
`queue.enqueueJSON({ url: \`${process.env.APP_BASE_URL}/api/qstash/sync-session\`, ... })`
y lo mismo para `refresh-barcos`. QStash guarda esa URL en el job y hace un POST de vuelta cuando le toca. Si la URL no es la de producción, el worker nunca se ejecuta y la sesión queda en `confirmada_pendiente_sync` para siempre.

---

## Paso 7 — Base de datos (Neon)

El schema **ya se pusheó** a Neon (`db/migrations/0000_famous_trish_tilby.sql`, aplicado con `drizzle-kit push`). No hay paso de migrate-on-deploy: el build **no** toca la DB.

Verificar que Vercel usa **la misma rama Neon** donde está el schema:

```powershell
vercel env ls
# revisar que el host/proyecto de DATABASE_URL (Production) == el de tu .env local
```

Si difieren, el `DATABASE_URL` de Vercel apunta a una DB vacía → login y `/admin/mapeos` fallan. Corregir con `vercel env rm DATABASE_URL production` + `vercel env add`.

**Cambios de schema futuros** se envían corriendo localmente contra el `DATABASE_URL` de producción:

```powershell
npm run db:push
```

(`drizzle.config.ts` lee `DATABASE_URL` vía `dotenv/config` → toma `.env`. Para apuntar a otra DB, exportá `DATABASE_URL` en la shell antes de correrlo.)

Si `/admin/mapeos` no muestra ninguna fila de almacén/courier, sembrá los catálogos base:

```powershell
npm run db:seed
```

(inserta los 7 almacenes y 13 couriers; es idempotente — `onConflictDoNothing`).

---

## Paso 8 — Sembrar un operario admin en la DB desplegada

`db:seed:operario` corre **localmente** pero escribe en la DB apuntada por `DATABASE_URL`. Como la DB de Neon es única (una sola rama) y `.env` ya tiene ese `DATABASE_URL`, esto siembra directamente la DB de producción:

```powershell
npm run db:seed:operario -- <login> <password> "Nombre Apellido"
```

Ejemplo:

```powershell
npm run db:seed:operario -- joaquin "una-clave-fuerte" "Joaquin Alizegui"
```

- El script hace `INSERT ... onConflictDoNothing` sobre `operarios` con `rol: 'admin'`. Si el `login` ya existe, **no lo pisa** (ni cambia la password).
- **Puede que ya exista** un `admin` / `admin1234` de desarrollo en la DB de Neon. Si es así: creá tu propio admin con login distinto y **borrá o desactivá** el `admin` de dev (`UPDATE operarios SET activo = false WHERE login = 'admin';` vía Neon SQL Editor).

Para no depender de `.env` local, alternativa one-off desde git-bash apuntando explícito:

```bash
DATABASE_URL='postgres://...neon...' npx tsx db/seed-operario-dev.ts joaquin 'una-clave-fuerte' 'Joaquin Alizegui'
```

---

## Paso 9 — Verificación post-deploy (checklist)

Sobre `https://webapp-paqueteria.vercel.app`:

- [ ] **(a)** `/login` carga sin error 500.
- [ ] **(b)** Login con el admin del paso 8 → redirige y se ve el shell de navegación (`/`, `/recepcion`, `/entrega`, `/pendientes`, `/admin`). El `proxy.ts` (middleware Next 16) solo chequea presencia de cookie `paqueteria_session`; la validación real está en las páginas.
- [ ] **(c)** `/admin/mapeos`: completar con valores **reales de la Odoo TEST**:
  - cada **almacén → `picking_type_id`** (número; buscar en Odoo test: Inventario → Configuración → Tipos de operación).
  - cada **courier → `product_id`** (el "producto" es el courier; buscar el `product.product` id en Odoo test).
  - Sin estos IDs, recepción/entrega no pueden escribir en Odoo.
- [ ] **(d)** `/admin` → botón **"Refrescar barcos ahora"**. Luego:
  - En **Upstash Console → QStash → Events / Queues → `odoo-sync`** aparece un job y se procesa OK (200).
  - La tabla `barcos_cache` en Neon se llena (Neon SQL Editor: `SELECT count(*) FROM barcos_cache;`).
  - Si el job falla con 401 → firma QStash mal (`QSTASH_*_SIGNING_KEY`). Si falla con error de conexión/URL → `APP_BASE_URL` mal (volver al paso 6).
- [ ] **(e)** **Vercel → Project → Settings → Cron Jobs**: aparece `/api/cron/refresh-caches` con schedule `0 6 * * *` (de `vercel.json`). Los crons **solo corren en deployments de producción**. Para probar sin esperar a las 06:00 UTC, "Run" desde el dashboard, o:
  ```bash
  curl -i "https://webapp-paqueteria.vercel.app/api/cron/refresh-caches" -H "Authorization: Bearer $CRON_SECRET"
  ```
  Debe devolver `{"ok":true}` y encolar un job `refresh-barcos` (la ruta **no** llama a Odoo directo, solo publica a la cola).
- [ ] **(f)** **Duración de funciones / plan Vercel.** Los workers declaran:
  - `app/api/qstash/refresh-barcos/route.ts` → `export const maxDuration = 60`
  - `app/api/qstash/sync-session/route.ts` → `export const maxDuration = 300`
  En plan **Hobby** el máximo es **60 s**: `sync-session` se cortaría a los 60 s y las sesiones grandes (decenas de paquetes × ~1 s/llamada a Odoo) **no drenarían**. Para honrar los 300 s hace falta plan **Pro** (Fluid Compute). **Decisión pendiente: contratar Pro antes de meter tráfico real de sesiones.**

---

## Paso 10 — Rollback

Si un deploy sale mal:

```powershell
vercel rollback
```

(promueve el deployment de producción anterior). O apuntá a uno concreto:

```powershell
vercel ls
vercel rollback <deployment-url>
```

Las env vars **no** se revierten con esto: si el problema fue una var, corregila con `vercel env rm/add` y `vercel --prod`.

---

## Apéndice — Tabla de referencia de variables de entorno

| Nombre | Propósito | De dónde sale el valor | ¿Ya conocido? |
| --- | --- | --- | --- |
| `DATABASE_URL` | Conexión Postgres (Neon serverless) para Drizzle. | Neon Console → proyecto `webapp-paqueteria` (`plain-base-40271679`) → Connect. Ya en `.env` local. | Sí |
| `ODOO_BASE_URL` | Base URL de la API JSON-2 de Odoo. | URL de la instancia **Odoo TEST**. Placeholder en `.env`. | No — confirmar URL test |
| `ODOO_API_KEY` | Bearer token para `POST /json/2/...` de Odoo. | Odoo → Preferencias → Seguridad → API Keys. Ya en `.env` local. | Sí |
| `ODOO_FIELD_BARCO` | Nombre del campo Studio "Barco" en `stock.picking`. | `x_studio_barco` (decisión confirmada 2026-09-03, no `x_studio_barco_4`). Ya en `.env` local. | Sí |
| `ODOO_FIELD_RECIBIDO_POR` | Nombre del campo Studio "Recibido por". | `x_studio_recibido_por`. Ya en `.env` local. | Sí |
| `QSTASH_TOKEN` | Publicar jobs en la cola `odoo-sync`. | Upstash Console → QStash → Details, o `vercel integration add upstash`. | No |
| `QSTASH_CURRENT_SIGNING_KEY` | Verificar firma de los callbacks de QStash (`lib/queue/verify.ts`). | Upstash → QStash → Signing keys → Current. | No |
| `QSTASH_NEXT_SIGNING_KEY` | Idem, rotación de claves. | Upstash → QStash → Signing keys → Next. | No |
| `QSTASH_QUEUE_NAME` | Nombre de la cola (autocreada con `parallelism: 1`). | Constante `odoo-sync`. | Sí |
| `APP_BASE_URL` | Base URL que QStash usa para el callback `${APP_BASE_URL}/api/qstash/...`. | URL de producción de Vercel, conocida tras el paso 5. | No — fijar en paso 6 |
| `SESSION_COOKIE_NAME` | Nombre de la cookie de sesión (auth + `proxy.ts`). | Constante `paqueteria_session`. | Sí |
| `CRON_SECRET` | Autoriza `/api/cron/refresh-caches`; Vercel Cron lo envía como `Authorization: Bearer`. | Generar: `openssl rand -hex 32`. | No — generar |

---

## Lista de comandos, en orden

```powershell
# 1. Requisitos
npm i -g vercel
vercel login

# 2. Crear/linkear proyecto (responder los prompts; framework = Next.js)
vercel link

# 3. QStash (opción A recomendada)
vercel integration add upstash
vercel env ls          # confirmar QSTASH_TOKEN / CURRENT / NEXT en production

# 4. Env vars en production (una por una, interactivo)
vercel env add DATABASE_URL production
vercel env add ODOO_BASE_URL production          # URL de Odoo TEST
vercel env add ODOO_API_KEY production
vercel env add ODOO_FIELD_BARCO production        # valor: x_studio_barco (sin _4)
vercel env add ODOO_FIELD_RECIBIDO_POR production
vercel env add QSTASH_TOKEN production            # omitir si la integración ya las cargó
vercel env add QSTASH_CURRENT_SIGNING_KEY production
vercel env add QSTASH_NEXT_SIGNING_KEY production
vercel env add QSTASH_QUEUE_NAME production       # valor: odoo-sync
vercel env add SESSION_COOKIE_NAME production     # valor: paqueteria_session
```

```bash
# 4b. (git-bash) CRON_SECRET y placeholder de APP_BASE_URL
openssl rand -hex 32
printf '%s' 'EL_SECRETO_GENERADO' | vercel env add CRON_SECRET production
printf '%s' 'https://placeholder.vercel.app' | vercel env add APP_BASE_URL production
```

```powershell
vercel env ls          # deben estar las 12 vars

# 5. Primer deploy — anotar la URL de producción
vercel --prod

# 6. Fijar APP_BASE_URL a la URL real y redeploy
vercel env rm APP_BASE_URL production
```

```bash
printf '%s' 'https://webapp-paqueteria.vercel.app' | vercel env add APP_BASE_URL production
```

```powershell
vercel --prod

# 7. DB — confirmar rama Neon; sembrar catálogos si faltan
npm run db:seed        # solo si /admin/mapeos no muestra almacenes/couriers

# 8. Sembrar operario admin (escribe en la DB de DATABASE_URL de .env)
npm run db:seed:operario -- <login> "<password>" "<Nombre Apellido>"

# 9. Verificación
#   (curl del cron desde git-bash)
```

```bash
curl -i "https://webapp-paqueteria.vercel.app/api/cron/refresh-caches" -H "Authorization: Bearer EL_SECRETO_GENERADO"
```

```powershell
# 10. Rollback si hace falta
vercel rollback
```

---

## Preguntas / decisiones abiertas

1. **Plan de Vercel: ¿Hobby o Pro?** El worker `sync-session` pide `maxDuration = 300`, imposible en Hobby (tope 60 s). Sin Pro, las sesiones con muchos paquetes no terminan de sincronizar. Recomendación: **Pro** antes de tráfico real.
2. **URL exacta de la instancia Odoo TEST** para `ODOO_BASE_URL`. Hay que confirmarla (login SaaS de Odoo → base test).
3. **Nombre del proyecto Vercel / dominio.** `webapp-paqueteria.vercel.app` es la sugerencia; si se usa otro, ajustar `APP_BASE_URL` en consecuencia.
4. **¿Integración Neon en Vercel o `DATABASE_URL` manual?** Si se instala la integración Neon (`vercel integration add neon`), gestiona `DATABASE_URL` sola pero podría crear/apuntar a otra rama — hay que garantizar que sea la misma donde está el schema. Si no, cargarla a mano (más control).
5. **¿Git remoto ahora o después?** El deploy por CLI no lo necesita. Si se quiere CI/preview deployments, crear repo GitHub, `vercel git connect`, y **fijar la rama de producción a `master`** (default `main`).
6. **Región de las funciones.** Neon está en `aws-eu-central-1` (Frankfurt). Conviene fijar la región de Vercel a `fra1` (Project → Settings → Functions, o `"regions": ["fra1"]` en `vercel.json`) para minimizar latencia DB. Decisión opcional.
7. **Operario `admin`/`admin1234` de dev en Neon:** ¿existe? Si sí, desactivarlo tras crear el admin real.
8. **Cron a las 06:00 UTC** (`0 6 * * *`): confirmar que esa hora (08:00 CET / 07:00 en invierno) es aceptable para el refresco diario de `barcos_cache`.
