# Runbook de QA — Mejora de UI y revisión (producción)

> **Fecha:** 2026-10-27
> **Alcance:** verificación manual, con dispositivos reales, de la rama `mejora-ui-revision` ya deployada. Cubre lo que los 1382 tests no pueden: la pistola Bluetooth, la tablet, el móvil, el ida y vuelta contra Odoo 19 y la cola real de QStash.
> **Origen:** Task 17 de `docs/superpowers/plans/2026-10-22-webapp-paqueteria-ui-revision-plan.md` y §10 de `docs/superpowers/specs/2026-10-22-webapp-paqueteria-ui-revision-design.md`.

---

## 0. Reglas que no se negocian

1. **Esto corre contra PRODUCCIÓN de Odoo.** No hay base de test. Todo se prueba con **un barco de QA**, **tandas chicas** (2–3 paquetes) y **tracking numbers inventados con prefijo `QA-`** (`QA-DHL-001`, …), salvo donde se pida un código real.
2. La webapp nunca hace `unlink()`. Lo que quede en Odoo se limpia como se hizo con `MB92/OUT/00403` y `MB92/OUT/00482`: cancelar las entregas generadas y sacar el stock de prueba con un ajuste de inventario (ver §8).
3. Odoo admite 1 request por segundo. Lo garantiza la cola `odoo-sync` (`parallelism: 1`). Ninguna prueba tiene que tocarla.
4. Lo escaneado no se pierde: vive en Postgres (`sesiones_escaneo` / `sesion_items`) desde el escaneo.
5. Cada escritura en Neon de producción durante el QA (solo la del paso E) necesita el OK del usuario en ese momento.

---

## 1. Estado del rollout (hecho el 2026-10-27)

| Paso | Resultado |
| --- | --- |
| Verificación local | 1382 tests, typecheck y build en verde (head `f37d55c`). |
| Ensayo en rama de Neon (`ensayo-migracion-0001`, copia de prod) | Limpieza + `0001` + `0002` en una transacción, sin errores. |
| Neon prod | Mismo SQL aplicado en una transacción. Después: 0 sesiones `en_curso`, 2 sincronizadas, 3 operarios, 13 couriers y 511 barcos intactos, y existen `courier_uso`, `sesiones_recepcion_abierta_unica`, `sesion_items_tracking_number_idx` y `almacenes.odoo_out_type_id`. |
| Antes del refresco | Prefijos de Neon (MB92, MPV, VLN, MLG, MLR, IBZ) = códigos de Odoo; cola `odoo-sync` con lag 0 y DLQ vacía. |
| `CRON_SECRET` | Faltaba en Vercel (el cron daba 401). Cargado en Production. |
| Deploy | `vercel --prod`, `dpl_An2TAYU66B2k7rMJx32cYvn44cdX`, 09:29 (Madrid), posterior al commit. `/login` 200; `/api/cron/refresh-caches` sin credenciales 401. |
| Primer refresco de Odoo | 8 almacenes activos (MB92, IBZ, MPV, VLN, MLR, MLG, TGN, COPIA); MLC inactivo; MB92 con `odoo_out_type_id = 2`; 73 couriers activos y 1 inactivo (producto 21, "UPS" viejo); DHL = producto 11; `courier_uso` 165 filas; `tracking_activos_cache` 4306 filas, todas con referencia de albarán; 509 barcos activos y 7 inactivos; asignaciones de Eduardo (MB92, MPV) y Veronika (MB92) intactas. |

**Producción no tiene tabla de migraciones de drizzle** (se creó con `drizzle-kit push`). Las migraciones que vengan se aplican a mano, en una transacción y ensayadas antes en una rama de Neon. No usar `drizzle-kit push`: pregunta de forma interactiva al agregar constraints únicos.

---

## 2. Antes de empezar

Completar estos datos; el resto del runbook los usa.

- **Barco de QA (Odoo):** APHRODITE (id 474). Verificado el 2026-10-27: existe una sola vez, está activo, sin sesiones en la app y sin líneas pendientes de entrega en MB92. Es un barco real: lo que genere el QA (entregas encadenadas) se entrega o se cancela al terminar (§5).
- **Almacén de QA:** MB92 (el de los operarios). Para el paso E, un almacén sin operarios reales: TGN (id 8).
- **URL:** `https://paquetes-odoo.vercel.app`
- **Usuarios:** Eduardo (`e.teixeira`) o Veronika (`v.shevchenko`) para el uso normal; `admin` para Pendientes y Admin.
- **Dispositivos:** tablet con la pistola Bluetooth ya emparejada; un móvil con datos.
- **Tracking numbers de prueba anotados:** `QA-DHL-001..005`, `QA-GLS-001..003`, y uno con guion (`QA-PAACK-001`, para ver que el guion no se transforma).
- **Acceso:** Odoo (para mirar `stock.picking`), Neon (lectura), consola de QStash.
- **Hecho antes por el usuario (§8 del spec):** campo "Recibido por" agregado al albarán con Studio; barcos y DHL duplicados archivados; stock de prueba limpiado; pistola y tablet configuradas (mismo idioma de teclado, Enter al final).

---

## 3. Chequeos

Marcar cada ítem y anotar el resultado. Un ítem que falla se corrige con su test y su commit (ver §7).

### A. Tablet con la pistola Bluetooth

- [ ] Entrar a Recepción y abrir una recepción del barco de QA. Escanear **10 códigos seguidos y rápidos**: aparecen 10 filas, en orden, sin perderse ni pegarse. Resultado: ______
- [ ] El Enter de la pistola **nunca activa un botón** (tocar un courier y escanear; borrar un paquete y escanear). Resultado: ______
- [ ] El campo de escaneo **no abre el teclado en pantalla**; el buscador de barcos y "Escribir a mano" **sí**, con la pistola conectada. Resultado: ______
- [ ] Un código con guion (`QA-PAACK-001`) queda **con guion** (no "/"). Resultado: ______
- [ ] Escanear el mismo código dos veces: la segunda vez avisa duplicado (franja roja, sonido distinto) y no se carga dos veces. Resultado: ______
- [ ] **Escanear sin elegir barco** desde el inicio: pregunta "¿Para qué barco es?", y al elegir el barco abre su recepción con el paquete adentro. Resultado: ______
- [ ] Escanear el mismo tracking en una segunda recepción abierta (otro barco): avisa "ya está en la recepción de <barco>". Resultado: ______
- [ ] Mientras se envía ("Enviar a Odoo"), disparar la pistola: ningún código se pierde. Resultado: ______

### B. Recepción real de 2–3 paquetes con dos couriers

- [ ] Cargar 2 paquetes DHL y 1 GLS en la recepción del barco de QA y tocar "Enviar a Odoo". Resultado: ______
- [ ] En "Enviadas hoy" pasa de "enviándose" a ✓ con la referencia (`MB92/IN/…`). Referencia: ______
- [ ] En Odoo, el picking quedó **`done`**, con un movimiento por courier y el **producto correcto** de cada uno (DHL = producto 11). Resultado: ______
- [ ] En Odoo, **"Recibido por"** (`x_studio_recibido_por_2`) = nombre de quien escaneó (si fueron dos operarios, los dos nombres separados por coma) y hay **nota en el chatter**. Resultado: ______
- [ ] En Odoo se **generó la entrega encadenada** (`MB92/OUT/…`). Referencia: ______
- [ ] Un paquete de **cada uno de los couriers más usados** de MB92 entra con su producto (probar al menos 3 más, en una segunda recepción chica). Resultado: ______
- [ ] En Neon: `sesiones_escaneo` pasó a `sincronizada`, con `odoo_picking_ref` completo. Resultado: ______
- [ ] Reenviar los mismos tracking en una recepción nueva: quedan como duplicados (ya están en Odoo) y aparece el aviso en Pendientes si se detectaron al enviar. Resultado: ______

### C. Móvil: entrega parcial y completa

La entrega depende de que el cron de Odoo ya haya asignado el barco a la entrega generada (una vez por minuto). Esperar unos 2 minutos después del paso B.

- [ ] En el móvil, Entrega: el barco de QA aparece con sus paquetes. Resultado: ______
- [ ] **Entrega parcial:** desmarcar un paquete (queda "en depósito"), pasar a firma, escribir un nombre, firmar y confirmar. Aparece "Entrega registrada, enviándose a Odoo" y figura en "Entregadas hoy". Resultado: ______
- [ ] En Odoo, en la entrega: **firma** guardada, **"Recibido por" = nombre del crew** y nota en el chatter. Resultado: ______
- [ ] En Odoo, el **backorder** tiene **exactamente** el paquete que quedó y el barco, **sin firma ni nombre**. Resultado: ______
- [ ] El **albarán impreso** (PDF) muestra la firma y, **debajo, el nombre** de quien recibe. Resultado: ______
- [ ] **Entrega completa del backorder:** repetir con el paquete restante. Queda `done`. Resultado: ______
- [ ] La firma se ve nítida y ocupa el ancho del móvil; "Borrar" funciona; girar el móvil no la pierde. Resultado: ______
- [ ] Un barco con **dos nombres iguales** (si hay) se distingue en la lista del paso 1. Resultado: ______
- [ ] Una línea sin tracking number se muestra "sin número" y se puede elegir (si no hay una real, probar solo con la lectura). Resultado: ______

### D. Cortar los datos del móvil al confirmar

- [ ] Con una entrega lista en el paso de firma, **apagar los datos**, tocar "Confirmar entrega": la pantalla **conserva nombre, firma y selección** y muestra el error. Resultado: ______
- [ ] Encender los datos y reintentar: queda **una sola entrega** (un solo registro en Neon con ese id y un solo albarán validado en Odoo). Resultado: ______
- [ ] Doble toque rápido en "Confirmar entrega": una sola entrega. Resultado: ______

### E. Pendientes y la cola (incluye el error forzado)

Esta prueba **escribe en Neon de producción**: pedirle el OK al usuario en el momento. Se hace con TGN, que no tiene operarios reales, y se restaura el dato al terminar.

- [ ] Asignar TGN al admin desde `/admin/operarios/<id>/almacenes` (o a un operario de prueba) y abrir una recepción de TGN con 1 paquete `QA-…` del barco de QA. Resultado: ______
- [ ] En Neon, vaciar `odoo_picking_type_id` del almacén TGN (`UPDATE almacenes SET odoo_picking_type_id = NULL WHERE prefijo = 'TGN'`). Anotar el valor original: **25**.
- [ ] Enviar la recepción de TGN. **Mientras tanto**, enviar una recepción chica de MB92: tiene que procesarse con normalidad (**la cola no se traba**). Resultado: ______
- [ ] En Pendientes aparece el problema de TGN, con la etiqueta **"Lo tiene que arreglar el admin"**, y el contador de la pestaña lo cuenta. Resultado: ______
- [ ] Un operario (no admin) ve el problema solo si tiene TGN, y **no** ve el botón "Marcar como resuelto". El admin ve **"Reintentar"** y **"Marcar como resuelto"**. Resultado: ______
- [ ] **Restaurar:** `UPDATE almacenes SET odoo_picking_type_id = 25 WHERE prefijo = 'TGN'`. Verificar con un `SELECT`.
- [ ] Como admin, tocar **"Marcar como resuelto"**: el problema sale de la lista y del contador, y queda un registro `revisado` en la auditoría. (La recepción de TGN no llega a Odoo; está bien, es de QA.) Resultado: ______
- [ ] Quitar la asignación de TGN al admin.
- [ ] Un **duplicado detectado al enviar** (paso B, último ítem) aparece como "Paquete que no entró por duplicado", dice dónde estaba ya, y **"Marcar como revisado"** lo saca. Resultado: ______

### F. Admin

- [ ] En `/admin`, "Refrescar ahora" muestra feedback y la fecha del último refresco. Resultado: ______
- [ ] `/admin/operarios`: la lista muestra los almacenes de cada operario; desactivar y reactivar un operario de prueba; el admin no puede desactivarse a sí mismo. Resultado: ______
- [ ] Agregar la app a la pantalla de inicio del móvil: abre como app, con el icono. Resultado: ______

### G. Al día siguiente

- [ ] El cron nocturno (02:00 UTC) corrió: `SELECT max(updated_at) FROM barcos_cache` es posterior a las 02:00 UTC. Si sigue en 08:45 UTC del 2026-10-27, mirar los logs de Vercel de `/api/cron/refresh-caches` (un 401 significa que `CRON_SECRET` no llegó al deploy). Resultado: ______

---

## 4. Si algo falla

- **Pendientes con un error:** abrir "Ver detalle". Los de conexión se reintentan solos; los de configuración los arregla el admin; "Reintentar" vuelve a encolar. Un albarán cancelado en Odoo no se recupera: volver a escanear en una recepción nueva y el admin marca el error como resuelto.
- **Cola trabada** (un mensaje en backoff largo bloquea toda la cola con `parallelism: 1`): mirar la cola `odoo-sync` en la consola de Upstash; vaciarla desde ahí (no desde la app).
- **Picking vacío en Odoo** por un corte justo al crearlo (el reintento crea otro): cancelar el borrador a mano. Nunca borrar.
- **El deploy activo no coincide con el código:** comparar `vercel inspect <url>` con la fecha del último commit antes de dudar del código.

---

## 5. Limpieza al terminar

- Cancelar en Odoo las entregas generadas por las recepciones de QA que no se hayan entregado, y sacar el stock de prueba con un **ajuste de inventario**. Anotar las referencias: ______
- Quitar cualquier asignación de almacén de prueba (TGN).
- Confirmar que `almacenes.odoo_picking_type_id` de TGN vale **25**.
- Borrar la rama de Neon `ensayo-migracion-0001` (con OK del usuario).

---

## 6. Pendientes menores conocidos (no bloquean)

- "Entregadas hoy" muestra el nombre plano de los barcos gemelos; la lista del paso 1 sí los distingue.
- Si Odoo se corta justo después de crear el picking, el reintento crea un segundo picking y queda un borrador vacío (ver §4).
- Dos admins que se desactivan entre sí en el mismo instante pueden pasar los dos (Neon-http no tiene transacciones).
- Dos móviles que confirman las mismas líneas en el mismo instante pueden pasar los dos (ventana de un request).
- El botón Atrás del navegador después de confirmar puede mostrar una foto vieja de `/entrega`.
- Las acciones de recepción no validan que el barco esté en `barcos_cache` ni que el courier esté activo.
- `db/seed.ts` quedó obsoleto para almacenes y couriers: ahora vienen de Odoo. El DECK se muestra con el código `COPIA` (el de Odoo); si se prefiere `DCK`, se cambia en Odoo.
- El deploy sube el `.env` local ("Detected .env file"): conviene un `.vercelignore` con `.env*`.

---

## 7. Resultados y cierre

Anotar acá lo que falló y cómo se resolvió; cada arreglo lleva su test y su commit.

| Fecha | Ítem | Qué pasó | Arreglo (commit) |
| --- | --- | --- | --- |
|  |  |  |  |

**Cierre:** cuando todo esté tildado, decidir con el usuario si `mejora-ui-revision` se mergea a `main`.
