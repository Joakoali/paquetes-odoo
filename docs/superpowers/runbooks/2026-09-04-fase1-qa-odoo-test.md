# Runbook de QA manual — Webapp Paquetería Fase 1 (base de TEST de Odoo)

> **Fecha:** 2026-09-04
> **Alcance:** verificación manual de integración de extremo a extremo, sobre dispositivos reales, después del deploy. Cubre lo que los 70 tests unitarios no pueden: lector de código de barras por hardware, cámara del teléfono, ida y vuelta real contra Odoo 19, y la cola real de QStash.
> **Origen:** expande el "Task 22" del plan `docs/superpowers/plans/2026-08-24-webapp-paqueteria-fase1-plan.md`.

---

## 0. Reglas que NO se negocian

1. **Todo se prueba contra la base de TEST de Odoo. Nunca producción.** Antes de empezar, confirmá que `ODOO_BASE_URL` del deployment apunta a la instancia de test.
2. La webapp **nunca** hace `unlink()` de un picking; sólo `action_cancel()` (en Fase 1 no hay ningún camino de cancelación: sólo se crean y validan pickings).
3. Odoo admite **≤ 1 request/segundo**, sin llamadas en paralelo. Lo garantiza la cola `odoo-sync` de QStash con `parallelism: 1`. Ninguna prueba debería requerir tocar esto.
4. Si un paso falla, **el trabajo escaneado no se pierde**: vive en Postgres (`sesiones_escaneo` / `sesion_items`) desde el momento del escaneo. Ver sección "Si algo falla".

---

## 1. Lo que el repositorio NO puede proveer (conseguir antes de empezar)

| Ítem | Detalle | Responsable |
| --- | --- | --- |
| **Lector de código de barras USB/Bluetooth** | Modo "teclado" (HID): emite las teclas del código + Enter. No requiere driver ni código especial. | Operaciones |
| **Teléfono o tablet con cámara** | Con una app de escaneo que escriba en el campo enfocado y mande Enter (p. ej. apps de "barcode keyboard"). El navegador del dispositivo tiene que poder abrir la URL del deployment. | Operaciones |
| **URL del deployment** | El dominio donde quedó publicada la webapp (Vercel). `APP_BASE_URL` debe coincidir con ese dominio para que QStash pueda llamar de vuelta a `/api/qstash/*`. | Quien hizo el deploy |
| **Credenciales / API key de Odoo TEST** | `ODOO_BASE_URL` + `ODOO_API_KEY` de la base de **test** (Preferencias → Seguridad de la cuenta → API Keys). Además acceso web a esa base de test para inspeccionar `stock.picking` etc. | Admin Odoo (Joaquín / Vanesa) |
| **Nombres reales de los campos custom en TEST** | Barco = **`x_studio_barco`** (sin `_4`), Recibido por = `x_studio_recibido_por`. El usuario ya confirmó (2026-09-03) usar `x_studio_barco` aunque `CONTEXTO-ODOO-WEBAPP.md` §4 liste `x_studio_barco_4` como el de test. **Verificar igual en el formulario de picking de test antes de arrancar** (el punto de Task 22 es justamente confirmarlo contra Odoo real) — si el campo real difiere, corregir `ODOO_FIELD_BARCO`. | Admin Odoo |
| **Al menos un barco de prueba en Odoo TEST** | Un registro en `project.project` (los "barcos"). Idealmente 1–2 barcos dedicados a QA para no ensuciar datos reales de test. | Admin Odoo |
| **`picking_type_id` reales de cada almacén en TEST** | Uno por almacén (MB92, IBZ, MPV, VLN, MLC, MLR, MLG). Se cargan en `/admin/mapeos`. | Admin Odoo |
| **`product.product` reales de cada courier en TEST** | El "producto" = el courier (Amazon, DHL, GLS, SEUR…). Se cargan en `/admin/mapeos`. | Admin Odoo |
| **Consola de QStash (Upstash)** | Acceso a <https://console.upstash.com/qstash> para ver la cola `odoo-sync`, sus mensajes y eventos. | Quien administra Upstash |
| **Acceso a la base Neon del proyecto** | Para inspeccionar `sesiones_escaneo`, `sesion_items`, `barcos_cache`, `tracking_activos_cache`. Proyecto Neon `plain-base-40271679` (rama del deployment). | Admin del proyecto |
| **El cron de fusión de entregas en Odoo TEST** | La Scheduled Action de `CONTEXTO-ODOO-WEBAPP.md` §6 tiene que existir en la base de test (no sólo en producción) y usar el mismo nombre de campo barco que `ODOO_FIELD_BARCO` (`x_studio_barco`). Ver Paso 6. | Admin Odoo |
| **Tracking numbers de prueba** | Al menos 5–6 cadenas distintas (pueden ser inventadas, p. ej. `QA-DHL-001`). Anotalas: se reutilizan entre pasos. | Tester |

---

## 2. Precondiciones (checklist previo, hacer una sola vez)

- [ ] **Deploy hecho** y accesible en la URL del deployment; `npm run build` sin errores; los 70 tests unitarios en verde (`npm test`).
- [ ] **Env vars del deployment** cargadas y apuntando a TEST (ver tabla en la sección 3).
- [ ] **Migraciones aplicadas** en la base Neon del deployment (`npm run db:push` o el generate/migrate equivalente). Tablas presentes: `operarios`, `sesiones_auth`, `almacenes`, `operario_almacenes`, `barcos_cache`, `couriers`, `sesiones_escaneo`, `sesion_courier_batches`, `sesion_items`, `tracking_activos_cache`, `audit_log`.
- [ ] **Seed base** corrido (`npm run db:seed`): 7 `almacenes` y 13 `couriers`, con `odoo_picking_type_id` / `odoo_product_id` todavía en `NULL`.
- [ ] **Operario admin creado** (`npm run db:seed:operario -- <login> <password> "<nombre>"` crea uno con `rol=admin`). Guardar login/clave.
- [ ] **Al menos un operario NO-admin** creado desde `/admin/operarios`, y **con al menos un almacén asignado** desde `/admin/operarios/<id>/almacenes`. Sin almacén asignado, `startSession` tira `ForbiddenError` y no se puede escanear.
- [ ] `/admin/mapeos` **completado** con los `picking_type_id` y `product_id` reales de TEST (esto es formalmente el Paso 1, abajo).
- [ ] `refreshBarcosCache()` **corrido una vez** (botón "Refrescar barcos ahora" en `/admin` — esto es el Paso 2).
- [ ] Consola de QStash abierta en la cola `odoo-sync`; confirmá que la cola existe y muestra `parallelism = 1` (se autocrea en el primer `publish`).
- [ ] Sesión de navegador limpia para el login; cookie de sesión = `paqueteria_session` (o el valor de `SESSION_COOKIE_NAME`).

---

## 3. Variables de entorno esperadas (deployment apuntando a TEST)

| Variable | Valor esperado para QA en TEST | Nota |
| --- | --- | --- |
| `DATABASE_URL` | Neon del deployment (rama de test) | No la base local de dev |
| `ODOO_BASE_URL` | `https://<instancia-test>.odoo.com` | **Nunca la de producción** |
| `ODOO_API_KEY` | API key de la base de **test** | Se invalida a propósito en el Paso 8 |
| `ODOO_FIELD_BARCO` | `x_studio_barco` | Decisión confirmada 2026-09-03 (no `x_studio_barco_4`). Verificar igual contra el formulario de test — es parte de Task 22 |
| `ODOO_FIELD_RECIBIDO_POR` | `x_studio_recibido_por` | Verificar contra el formulario de test |
| `QSTASH_TOKEN` | token real de Upstash | |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | claves reales de Upstash | Sin ellas, `/api/qstash/*` responde 401 y nada sincroniza |
| `QSTASH_QUEUE_NAME` | `odoo-sync` | |
| `APP_BASE_URL` | la URL pública del deployment | QStash llama a `${APP_BASE_URL}/api/qstash/sync-session` |
| `SESSION_COOKIE_NAME` | `paqueteria_session` | |
| `CRON_SECRET` | secreto del cron de Vercel | Lo usa `/api/cron/refresh-caches` |

---

## 4. Los 8 pasos

Cada paso: **acción en la UI → comportamiento esperado en la UI → qué verificar en Odoo TEST / Neon / QStash.**

---

### Paso 1 — Cargar los mapeos de IDs de Odoo (reales, base TEST)

**Acción (UI)**
1. Login como **admin** en `<URL>/login`.
2. Ir a `/admin/mapeos`.
3. Para **cada almacén** (MB92, IBZ, MPV, VLN, MLC, MLR, MLG): buscar en Odoo TEST el `picking_type_id` del tipo de operación *incoming* de ese almacén (en Odoo: Inventario → Configuración → Tipos de operaciones; el ID está en la URL o vía "Ver metadatos"). Escribir el número en el campo del almacén y "Guardar".
4. Para **cada courier** que se vaya a usar en la prueba (mínimo los 2 del Paso 3, p. ej. DHL y GLS): buscar el `product.product` correspondiente en Odoo TEST y cargar su ID.
5. Confirmar que `ODOO_BASE_URL` / `ODOO_API_KEY` del deployment apuntan a TEST.

**Comportamiento esperado (UI)**
- Cada formulario guarda sin error y al recargar `/admin/mapeos` el `defaultValue` del input muestra el número cargado.
- La página exige que el admin esté logueado (`requireAdminFromCookies`); un no-admin recibe 403.

**Verificación (Neon)**
- Tabla `almacenes`: `odoo_picking_type_id` no nulo y correcto en cada fila que se vaya a usar.
- Tabla `couriers`: `odoo_product_id` no nulo en los couriers de prueba.

**Verificación (Odoo TEST)**
- Los `picking_type_id` cargados corresponden a tipos de operación con `code = incoming` del almacén correcto.
- Los `product_id` cargados existen y son los productos-courier correctos.

> Si un almacén queda sin `odoo_picking_type_id`, el worker de recepción lanza `Almacén N no tiene odoo_picking_type_id configurado` y la sesión cae en `error`. Igual para un courier sin `odoo_product_id`.

---

### Paso 2 — Correr `refreshBarcosCache()` una vez

**Acción (UI)**
1. Como admin, ir a `/admin`.
2. Sección "Mantenimiento" → botón **"Refrescar barcos ahora"**.

**Comportamiento esperado (UI)**
- El form (`refreshBarcosAction`) encola un job en la cola `odoo-sync` (`publishRefreshBarcos` → `${APP_BASE_URL}/api/qstash/refresh-barcos`). No hay feedback visual explícito además de que la página no da error.
- El cron diario (`vercel.json`, `0 2 * * *` UTC → `/api/cron/refresh-caches`) hace lo mismo automáticamente; este botón es el disparo manual.

**Verificación (consola QStash)**
- En la cola `odoo-sync` aparece un mensaje nuevo con destino `.../api/qstash/refresh-barcos` y termina en estado **Delivered** (HTTP 200). Si queda en error, revisar `QSTASH_*` y `APP_BASE_URL`.

**Verificación (Neon)**
- Tabla `barcos_cache`: una fila por cada `project.project` de Odoo TEST, con `odoo_id` y `nombre`. `updated_at` reciente.
- Correr el botón **una segunda vez** y confirmar que no se duplican filas (upsert por `odoo_id`) y que `nombre` se actualiza si un barco fue renombrado en Odoo.

**Verificación (UI de recepción)**
- Login como el operario no-admin → `/recepcion` → en "Buscar barco" escribir ≥ 2 letras del nombre de un barco de test → aparece al menos un resultado como botón. (Búsqueda `ILIKE %query%` sobre `barcos_cache`.)

---

### Paso 3 — Ciclo completo de recepción con lector de código de barras por hardware

**Preparación**
- Conectar el lector USB/Bluetooth a la notebook/PC que corre el navegador con la webapp.
- Login como el **operario no-admin** con almacén asignado.
- Tener a mano ≥ 3 tracking numbers repartidos en **2 couriers** (p. ej. `QA-DHL-001`, `QA-DHL-002` para DHL y `QA-GLS-001` para GLS).

**Acción (UI) — `/recepcion`**
1. Elegir el almacén en el `<select>` (si el operario tiene uno solo, ya viene preseleccionado).
2. En "Buscar barco" tipear el nombre del barco de test y hacer clic en el resultado. → esto llama `startSession(almacenId, barcoOdooId)` y crea la sesión.
3. Aparece "Elegir courier". Clic en el primer courier (DHL). → `startCourierBatch` crea la tanda.
4. El foco queda en el input "Escanear tracking number". **Sin tocar el mouse**, disparar el lector sobre los códigos de DHL uno por uno. Cada disparo del lector = teclas + Enter → cada `Enter` ejecuta `scanTracking` y agrega el ítem a la lista.
5. Verificar que cada tracking aparece en la lista y que el input se limpia y re-enfoca solo (sin clics).
6. Clic en **"Listo"** → `finishCourierBatch`, vuelve al selector de courier.
7. Clic en el segundo courier (GLS), escanear su(s) tracking(s) igual.
8. Clic en **"Listo"**.
9. Clic en **"Confirmar sesión"** → `confirmSession`: la sesión pasa a `confirmada_pendiente_sync` y se publica a `odoo-sync`.

**Comportamiento esperado (UI)**
- El lector escribe en el input y agrega ítems **sin ningún clic extra**. Si el lector inserta un salto de línea intermedio o caracteres raros, anotarlo (puede requerir reconfigurar el sufijo del lector a solo-Enter).
- Ítems no duplicados salen en color normal; no debería haber ninguno en rojo en esta corrida "limpia".
- Tras "Confirmar sesión" la UI limpia el estado (barco, ítems).

**Verificación (consola QStash)**
- Un mensaje nuevo en `odoo-sync` con destino `.../api/qstash/sync-session`, body `{"sesionId":"..."}`, estado **Delivered / 200**.

**Verificación (Neon)**
- `sesiones_escaneo`: fila con `tipo='recepcion'`, `estado` que evoluciona `confirmada_pendiente_sync` → `sincronizada`, `odoo_picking_id` no nulo, `synced_at` seteado, `intentos=0`, `ultimo_error` nulo.
- `sesion_courier_batches`: 2 filas para esa sesión, cada una con `odoo_move_id` no nulo.
- `sesion_items`: una fila por tracking, `estado='sincronizado'`.
- `tracking_activos_cache`: una fila por cada tracking escaneado, con `odoo_picking_id` = el picking creado.

**Verificación (Odoo TEST)** — abrir Inventario y buscar el picking nuevo (o ir por su ID de `sesiones_escaneo.odoo_picking_id`):
- **`stock.picking`**: registro nuevo, `picking_type_id` = el del almacén elegido, `picking_type_code='incoming'`, `state='done'`, campo **barco** (`ODOO_FIELD_BARCO`, = `x_studio_barco`) = el barco de test, campo **recibido por** (`x_studio_recibido_por`) poblado (contiene el **UUID del operario**, no su nombre — ver nota), y en el chatter un mensaje **"Registrado vía Webapp Paquetería por operario &lt;uuid&gt;"**.
- **`stock.move`**: 2 movimientos (uno por courier). Cada uno con `product_id` = el producto-courier, `product_uom_qty` = cantidad de tracking numbers de ese courier, `name='Recepción webapp'`, `state='done'`.
- **`stock.move.line`**: una línea por paquete. Cada una con `lot_name` (o `lot_id.name`) = el tracking number exacto, `quantity=1`, `picking_id` = el picking, `product_id` = el courier correcto.
- No hay líneas fantasma (demanda 1 / cantidad 0) — por diseño no hay campo de cantidad esperada.

> **Nota "recibido por":** el worker escribe `sesion.operarioId` (un UUID) en `x_studio_recibido_por`. Confirmar que ese campo en TEST es de tipo texto/char y acepta el valor. Si el nombre del campo está mal en la env var, la escritura falla **después** de crear y validar el picking → la sesión queda en `error` con el picking ya `done` (ver Paso 8 para el patrón de recuperación).

---

### Paso 4 — Mismo ciclo de recepción, escaneando con la cámara del teléfono/tablet

**Acción (UI)**
1. En el teléfono/tablet, abrir la URL del deployment, login como el operario.
2. Repetir exactamente el flujo del Paso 3 en `/recepcion`, pero usando la **cámara** (vía la app de escaneo tipo teclado) para meter cada tracking number en el input enfocado.
3. Usar tracking numbers **nuevos** (p. ej. `QA-CAM-001`…), distintos a los del Paso 3, para no gatillar duplicados todavía.

**Comportamiento esperado (UI)**
- La app de cámara escribe el código + Enter en el input enfocado; el ítem se agrega igual que con el lector físico. **No hay código específico de cámara en la webapp** — sólo un input con foco. Confirmar que efectivamente funciona así en el dispositivo real (algunas apps no mandan Enter → anotarlo).
- El input se re-enfoca solo entre escaneos.

**Verificación (Odoo TEST / Neon / QStash)**
- Igual que el Paso 3: picking `incoming` nuevo `done`, `stock.move` por courier, `stock.move.line` con los `lot_name` correctos, campo barco poblado, mensaje en el chatter, `sesiones_escaneo.estado='sincronizada'`.

---

### Paso 5 — Detección de duplicados de punta a punta

Dos sub-casos.

#### 5a — Duplicado por cache (`tracking_activos_cache`), detectado en la UI antes de confirmar

**Acción (UI)**
1. Nueva sesión en `/recepcion` para el **mismo barco** del Paso 3.
2. Elegir un courier, y escanear **uno de los tracking numbers ya usados en el Paso 3** (que ya quedó en `tracking_activos_cache`).

**Comportamiento esperado (UI)**
- El ítem aparece en la lista **en rojo, con el sufijo "(duplicado)"** inmediatamente, sin llamada a Odoo (`scanTracking` consultó `isKnownDuplicate` contra `tracking_activos_cache` y lo ya escaneado en la sesión).
- Escanear el mismo número **otra vez en la misma sesión** también devuelve `duplicado` y no inserta una segunda fila (respeta la constraint `unique(courier_batch_id, tracking_number)`).

**Verificación (Neon)**
- `sesion_items`: el tracking repetido queda con `estado='duplicado'`.
- Si se confirma igual la sesión: el worker excluye ese tracking del `stock.move` (no llega a Odoo). Si **todos** los tracking de la sesión eran duplicados, no se crea ningún `stock.move`, no se valida el picking, y la sesión termina `sincronizada` con `ultimo_error = "Todos los tracking numbers eran duplicados — no se creó ningún movimiento"`.
- `/pendientes` → sección **"Sincronizadas con duplicados detectados"** lista esa sesión.

#### 5b — Duplicado que aparece en Odoo *después* del escaneo (chequeo final en vivo al confirmar)

**Acción**
1. En **Odoo TEST directamente** (UI de Odoo, no la webapp): crear a mano una `stock.move.line` con un `lot_name` **nuevo** que la webapp no conoce (p. ej. `QA-LIVE-999`) — por ejemplo dentro de un picking incoming de test cualquiera, o creando la move line en un picking en borrador. Lo importante: que exista una `stock.move.line` con ese `lot_id.name` y `state != 'cancel'`.
2. En la webapp, nueva sesión de recepción, escanear `QA-LIVE-999`.

**Comportamiento esperado (UI)**
- En el escaneo, la UI lo marca **`ok`** (verde), porque `QA-LIVE-999` todavía no está en `tracking_activos_cache`.
- Al **"Confirmar sesión"**, el worker corre `checkDuplicateTrackingNumbers` (una sola llamada `stock.move.line.search_read` con `['lot_id.name','in',[...]]` y `['state','!=','cancel']`) y detecta `QA-LIVE-999` como duplicado en vivo.

**Verificación (Neon)**
- `sesion_items`: `QA-LIVE-999` pasó a `estado='duplicado'`.
- Los demás tracking de esa misma sesión (si los hubo) **sí** se sincronizan — un duplicado no bloquea a los paquetes legítimos.
- La sesión termina `estado='sincronizada'`; aparece en `/pendientes` → "Sincronizadas con duplicados detectados".

**Verificación (Odoo TEST)**
- El picking creado por esa sesión **no** contiene una `stock.move.line` con `lot_name = QA-LIVE-999`.

---

### Paso 6 — El cron de producción sigue fusionando y poblando el barco en la entrega

Contexto: en Odoo, validar una recepción `incoming` genera automáticamente una entrega `outgoing` encadenada (`move_orig_ids`). La Scheduled Action de `CONTEXTO-ODOO-WEBAPP.md` §6 corre cada minuto, le pone el barco a esa entrega y la fusiona con otra entrega pendiente del mismo **barco + `picking_type_id`**.

**Precondición**
- La Scheduled Action §6 tiene que estar **activa en la base de TEST** y usar el mismo nombre de campo barco que `ODOO_FIELD_BARCO` (`x_studio_barco`). Confirmar con el admin de Odoo antes de este paso.

**Acción**
1. Tras el Paso 3 (picking incoming validado), en Odoo TEST buscar la entrega `outgoing` generada: partir del picking incoming → `move_ids` → `move_ids.move_dest_ids` → `picking_id`, o buscar `stock.picking` con `picking_type_code='outgoing'`, `origin` relacionado, `state not in (draft,done,cancel)`.
2. Esperar 1–2 minutos a que corra el cron (o gatillarlo a mano desde Ajustes → Técnico → Acciones planificadas → "Ejecutar manualmente").
3. Para probar la **fusión**: crear una segunda recepción por la webapp (Paso 3 abreviado, mismo barco, mismo almacén, 1 courier, 1 tracking) y dejar que el cron procese ambas entregas.

**Comportamiento / verificación (Odoo TEST)**
- La entrega `outgoing` de la primera recepción pasa a tener el campo barco (`x_studio_barco`) = el barco (antes estaba en `False`).
- Tras la segunda recepción + cron: las dos entregas `outgoing` del mismo barco+almacén quedan **fusionadas en una sola** — la más nueva se `action_cancel()` y sus `move_ids` + `move_line_ids` (con los tracking numbers) se movieron a la que sobrevive; en el chatter de la superviviente hay un mensaje "Se fusionaron paquetes de la entrega …".
- El comportamiento es **idéntico** al de una recepción cargada desde la UI de Odoo: para comprobarlo, crear una recepción incoming a mano en Odoo TEST (mismo barco+almacén), validarla, y confirmar que su entrega también se fusiona en la misma outgoing.
- Ninguna línea de otro almacén se mezcló (el cron filtra por `picking_type_id`).

---

### Paso 7 — Ciclo completo de entrega con firma

**Precondición**
- Existe al menos una entrega `outgoing` pendiente en Odoo TEST para el barco+almacén del Paso 3 (generada por los pasos anteriores), en `state` distinto de `draft/done/cancel`.

**Acción (UI) — `/entrega`** (login como el operario no-admin)
1. Elegir el **almacén** en el `<select>`.
2. En "Buscar barco" tipear y seleccionar el **mismo barco** del Paso 3. → `loadPendingDeliveries(almacenId, barcoOdooId)` hace una lectura **en vivo** a Odoo (`getPendingOutgoing`: `stock.picking.search_read` filtrando por `picking_type_id`, campo barco, `state not in (draft,done,cancel)`, `picking_type_code='outgoing'`; luego `stock.move.line.search_read` por `picking_id in [...]`).
3. Aparece "Pendiente de entrega" con una fila por entrega, cada una mostrando `nombre (tracking1, tracking2, …)`. Todas vienen tildadas por defecto.
4. Confirmar que los **tracking numbers listados coinciden** con los que se cargaron en los Pasos 3/4 (y con lo que muestra Odoo).
5. (Opcional, para probar entrega parcial → backorder: destildar alguna entrega.)
6. En el canvas **"Firma del receptor"**, dibujar una firma con el dedo (táctil) o el mouse.
7. Clic en **"Confirmar entrega"** (se habilita sólo si hay firma y ≥ 1 entrega tildada).

**Comportamiento esperado (UI)**
- El canvas dibuja el trazo (pointer events; funciona con mouse, dedo y stylus).
- Tras confirmar: la UI muestra **"Entrega confirmada, sincronizando con Odoo."**
- `confirmEntregaSession` recorta el prefijo `data:image/png;base64,` y guarda sólo el base64 crudo.

**Verificación (consola QStash)**
- Mensaje nuevo en `odoo-sync` → `.../api/qstash/sync-session`, **Delivered / 200**.

**Verificación (Neon)**
- `sesiones_escaneo`: fila con `tipo='entrega'`, `odoo_picking_ids` = array con los IDs seleccionados, `firma_data` no nula (base64 sin prefijo), `estado` `confirmada_pendiente_sync` → `sincronizada`, `synced_at` seteado.

**Verificación (Odoo TEST)** — para cada picking en `odoo_picking_ids`:
- `state='done'`.
- `signature` poblado (imagen) y `is_signed = true`.
- En el chatter: "Entrega confirmada vía Webapp Paquetería por operario &lt;uuid&gt;".
- Si se hizo entrega parcial: existe un **backorder** nativo con las líneas no entregadas, en estado pendiente.

---

### Paso 8 — Camino de error + reintento idempotente

**Acción**
1. En las env vars del deployment, cambiar `ODOO_API_KEY` a un valor **inválido** (p. ej. `invalido-qa`) y redeploy / re-cargar la variable para que tome efecto.
2. En la webapp, hacer una **nueva sesión de recepción** completa (Paso 3 abreviado: 1 courier, 2 tracking numbers nuevos, p. ej. `QA-ERR-001/002`) y **"Confirmar sesión"**.

**Comportamiento esperado**
- QStash entrega el job a `/api/qstash/sync-session`; el worker llama a Odoo, recibe error de auth (`OdooError`), y la ruta captura la excepción:
  - `sesiones_escaneo`: `estado='error'`, `intentos` incrementado (1), `ultimo_error` con el mensaje de Odoo.
  - La respuesta HTTP es 500 → QStash reintentará con backoff por su cuenta (esperable ver varios intentos fallidos en la consola de QStash).
- En la webapp, `/pendientes` → sección **"Errores de sincronización"** lista la sesión con `intentos` y el texto del error, y un botón **"Reintentar"**.
- **Nada se perdió**: `sesion_items` sigue con las 2 filas (`estado='ok'`), `sesion_courier_batches` con su fila (`odoo_move_id` NULL), y `sesiones_escaneo.odoo_picking_id` probablemente NULL (falló antes de crear el picking) — o, si llegó a crearlo, quedó seteado y se reutiliza.

**Acción — recuperación**
3. Restaurar `ODOO_API_KEY` al valor **válido** de TEST (redeploy / recarga).
4. En `/pendientes`, clic en **"Reintentar"** para esa sesión (`retrySessionAction` → `retrySession` → `publishSync({sesionId})`, re-encola el mismo job).

**Comportamiento esperado**
- El worker vuelve a correr `syncRecepcionSession`:
  - Si `estado==='sincronizada'` ya, no hace nada (no aplica acá).
  - Si `odoo_picking_id` ya existía (de un intento previo), **lo reutiliza** — no crea un picking nuevo.
  - Cada `sesion_courier_batches` con `odoo_move_id` ya seteado se **saltea**.
  - Si el picking ya estaba `done`/`cancel` en Odoo, **no** se re-valida.
- La sesión pasa a `estado='sincronizada'`.

**Verificación (Odoo TEST) — el punto clave: idempotencia**
- Existe **exactamente UN** `stock.picking` incoming para esa sesión (no dos). Buscar por barco + fecha, o partir de `sesiones_escaneo.odoo_picking_id`.
- Ese picking tiene el `stock.move` y las `stock.move.line` esperadas (`QA-ERR-001/002` como `lot_name`), `state='done'`, campo barco poblado.
- `tracking_activos_cache` tiene `QA-ERR-001` y `QA-ERR-002` con el `odoo_picking_id` correcto.

**Verificación (Neon)**
- `sesiones_escaneo`: `estado='sincronizada'`, `synced_at` seteado, `intentos` refleja los reintentos (no vuelve a 0).
- `sesion_courier_batches.odoo_move_id` no nulo; `sesion_items.estado='sincronizado'`.

---

## 5. Plantilla de registro de resultados

| Paso | Fecha | Tester | Dispositivo | Navegador | Resultado (PASS / FAIL) | Notas / IDs Odoo / observaciones |
| --- | --- | --- | --- | --- | --- | --- |
| 1 — Mapeos de IDs | | | | | | |
| 2 — refreshBarcosCache | | | | | | |
| 3 — Recepción con lector hardware | | | | | | picking_id: |
| 4 — Recepción con cámara | | | | | | picking_id: |
| 5a — Duplicado por cache (UI) | | | | | | |
| 5b — Duplicado live al confirmar | | | | | | |
| 6 — Cron fusión + barco en entrega | | | | | | outgoing_id: |
| 7 — Entrega con firma | | | | | | picking_ids: |
| 8 — Error + reintento idempotente | | | | | | picking_id (único): |

**Ambiente de la corrida**

| Campo | Valor |
| --- | --- |
| URL del deployment | |
| Commit / versión desplegada | |
| `ODOO_BASE_URL` (test) | |
| `ODOO_FIELD_BARCO` usado | |
| `ODOO_FIELD_RECIBIDO_POR` usado | |
| Proyecto Neon / rama | |
| Barco(s) de test usados (nombre + odoo_id) | |
| Lector de hardware (modelo) | |
| Dispositivo de cámara (modelo + app) | |

---

## 6. Si algo falla

1. **El trabajo escaneado nunca se pierde.** Vive en `sesiones_escaneo` + `sesion_courier_batches` + `sesion_items` desde el momento del escaneo, independientemente de Odoo.
2. **Primer lugar a mirar: `/pendientes`.**
   - "Errores de sincronización": sesiones en `estado='error'`. Muestra `intentos` y `ultimo_error`. Botón **"Reintentar"** re-encola el job (`publishSync`). El worker es idempotente: no duplica pickings ni move lines (reusa `odoo_picking_id`, saltea batches con `odoo_move_id`, no re-valida pickings `done`/`cancel`).
   - "Sincronizadas con duplicados detectados": la sesión sincronizó, pero al menos un paquete quedó afuera del picking porque su tracking ya estaba vivo en Odoo. El paquete físico existe y no está en ningún picking → alguien tiene que resolverlo a mano en Odoo.
3. **Reintento automático:** además del botón, QStash reintenta los jobs con `500` por su cuenta con backoff. Revisar la consola de QStash (cola `odoo-sync`) para ver intentos, códigos HTTP y cuerpos de error.
4. **Diagnóstico por capa:**
   - Job nunca llegó → revisar `QSTASH_TOKEN` / `APP_BASE_URL`, y que la cola `odoo-sync` exista con `parallelism:1`.
   - Job llega y da 401 → `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` mal.
   - Job da 500 con mensaje de Odoo → leer `ultimo_error` en `sesiones_escaneo`: típicamente `ODOO_API_KEY` inválida, `picking_type_id`/`product_id` sin mapear, o nombre de campo custom (`ODOO_FIELD_BARCO` / `ODOO_FIELD_RECIBIDO_POR`) equivocado para la base de test.
   - `addCourierMoveWithLines` tiene un `TODO(task-22)`: en Odoo 19 `qty_done` desapareció (ahora `quantity` en `stock.move.line`) y el flag `picked` puede tener que ir en la línea y no en el `stock.move`. Si la validación del picking falla o las cantidades quedan mal, es el primer sospechoso — anotar el error exacto de Odoo.
5. **Nunca** borrar pickings desde Odoo para "limpiar" una prueba fallida: usar `action_cancel()` (cancelar) desde la UI de Odoo. Idealmente trabajar con barcos de QA dedicados en la base de test.
6. **`audit_log`** existe como tabla pero en Fase 1 no se escribe desde el código — la traza de auditoría real es el `message_post` en el chatter de cada picking en Odoo.

---

## 7. Referencias del repo

- Plan: `docs/superpowers/plans/2026-08-24-webapp-paqueteria-fase1-plan.md` (Task 22, y Tasks 13–21).
- Spec: `docs/superpowers/specs/2026-08-24-webapp-paqueteria-fase1-design.md` (§4.1 recepción, §4.2 entrega, §5 errores).
- Contexto Odoo: `CONTEXTO-ODOO-WEBAPP.md` (§4 modelos/campos, §6 cron de fusión).
- Odoo: `lib/odoo/client.ts` (JSON-2, throttle ~1/s), `lib/odoo/pickings.ts` (create/move/validate/dup-check/pending-outgoing).
- Sync workers: `lib/sync/recepcion.ts`, `lib/sync/entrega.ts`, `lib/sync/pendientes.ts`.
- Caches: `lib/cache/barcos.ts`, `lib/cache/trackingActivos.ts`.
- Cola: `lib/queue/publish.ts`, `lib/queue/verify.ts`; rutas `app/api/qstash/sync-session/route.ts`, `app/api/qstash/refresh-barcos/route.ts`, `app/api/cron/refresh-caches/route.ts`.
- UI: `app/(app)/recepcion/*`, `app/(app)/entrega/*`, `app/(app)/pendientes/*`, `app/admin/*`.
