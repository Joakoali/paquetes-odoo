# Runbook — Rendimiento (despliegue y QA)

> **Fecha:** 2026-10-29
> **Alcance:** desplegar los commits de rendimiento de la rama `claude/youthful-hawking-ciqpqn`, aplicar la migración `0003` y verificar con dispositivos reales lo que los tests no cubren.
> **Reglas:** las de §0 de `2026-10-22-qa-mejora-ui.md`. No hay base de test: todo corre contra **producción de Odoo**, con el barco de QA (APHRODITE, id 474), tandas de 2–3 paquetes y códigos inventados `QA-…`. Limpieza al terminar como en su §5.

---

## 1. Qué cambia

| Commit | Cambio | Riesgo |
| --- | --- | --- |
| `e907fe3` | Sesión y operario en una consulta, compartida entre layout y página (`cache` de React). | Bajo |
| `0752c6c` | Escaneo: lecturas en paralelo y el paquete escrito en una sentencia que bloquea la recepción `FOR SHARE`. Los descartes bloquean la recepción primero. | Medio (probado con dos sesiones contra Postgres real) |
| `79a49ea` | Las líneas de un barco de Entrega en **una** llamada a Odoo en vez de dos (≈ −1 s al abrir un barco y al confirmar). | Bajo (solo lectura) |
| `0df17aa` | Sin `router.refresh()` duplicados: "Enviar todas", "Enviar ahora" y el cambio de almacén renderizan una vez. | Bajo |
| `e2b1c34` | Índices (`0003`) y el conteo de Pendientes con una subconsulta única. | Bajo (el código no depende de los índices) |
| `9c66a91` | Pantallas de carga en Entrega, barco de Entrega y Pendientes. No en Recepción, a propósito. | Bajo |
| `ef51c9a` | Las Server Actions (cada escaneo) ya no pasan por `proxy.ts`. | Bajo |
| `6a131d6` | Worker de recepción: solo `button_validate`, y movimiento + líneas en una llamada (11 → 8 llamadas con un courier). | **Escribe en Odoo:** va aparte, con QA inmediato (§4) |

---

## 2. Orden

1. Desplegar hasta `ef51c9a` (commits 1–7) y hacer los chequeos de §3.
2. Aplicar `0003` (§5). Puede ir antes o después del paso 1.
3. Desplegar `6a131d6` solo, y hacer enseguida la recepción de QA de §4.

---

## 3. Chequeos de los commits 1–7

- [ ] **Tablet:** 10 códigos seguidos y rápidos en una recepción del barco de QA: 10 filas, en orden, ninguna perdida. En DevTools → Network, cada POST con `Next-Action` tarda menos que antes. Resultado: ______
- [ ] **Sesión vencida:** con la cookie `paqueteria_session` borrada, un escaneo responde "Tu sesión venció. Volvé a entrar." (antes: "No hubo respuesta del servidor"). Resultado: ______
- [ ] **Descartar** una recepción de QA con paquetes, mientras otra tablet escanea en ella: o el paquete entra y se descarta con todo, o la segunda tablet dice que la recepción no existe. Nunca "Algo falló". Resultado: ______
- [ ] **Móvil, pestaña Entrega:** al tocarla aparece al instante "Buscando en Odoo los barcos…" y después la lista. Resultado: ______
- [ ] **Abrir un barco** (el de QA, con algo pendiente): "Leyendo en Odoo…" al instante, y las mismas líneas que muestra Odoo para ese barco y almacén. Resultado: ______
- [ ] **Confirmar una entrega** de QA: tarda ≈ 1 s menos que antes. Resultado: ______
- [ ] **"Enviar ahora"** en un barco con paquetes sin enviar: una sola request en Network, y el aviso de siempre. Resultado: ______
- [ ] **Pendientes:** la pestaña muestra la carga al instante, y el número de la pestaña coincide con las tarjetas. Resultado: ______
- [ ] **Cambio de almacén** (un operario con dos): cambia la pastilla y las listas, con una sola request. Resultado: ______

---

## 4. QA del commit del worker (`6a131d6`), apenas desplegado

- [ ] Recepción del barco de QA con **2 paquetes DHL y 1 GLS** (`QA-DHL-0xx`, `QA-GLS-0xx`) → "Enviar a Odoo". Resultado: ______
- [ ] En "Enviadas hoy" pasa a ✓ con la referencia (`MB92/IN/…`). Referencia: ______
- [ ] En Odoo, el picking quedó **`done`**, con **un movimiento por courier** (DHL = producto 11) y **un lote por tracking number**. Resultado: ______
- [ ] "Recibido por" con el nombre de quien escaneó, nota en el chatter, y entrega encadenada (`MB92/OUT/…`) generada. Resultado: ______
- [ ] En la consola de QStash, el job de `sync-session` tardó menos que los anteriores (~8–9 s en vez de ~12–13 s). Resultado: ______

**Si el picking no queda `done`** (la recepción aparece en Pendientes con "Odoo no validó el albarán" o "Odoo pidió confirmar"): `vercel rollback` al deploy anterior y "Reintentar" en Pendientes. El reintento retoma el picking donde quedó: no crea movimientos de nuevo, y valida como antes.

---

## 5. Migración `0003` (índices)

Producción no tiene tabla de migraciones: se aplica a mano, primero en una rama de Neon.

Mientras se construye, `CREATE INDEX` frena las escrituras de su tabla: escaneos, envíos y entregas esperan a que termine. Con las tablas de hoy son milisegundos, pero conviene aplicarlo fuera del turno. Si tiene que ser con gente trabajando, usar `CREATE INDEX CONCURRENTLY` (no frena escrituras), uno por uno y **sin** `BEGIN`/`COMMIT`, porque no corre dentro de una transacción.

```sql
BEGIN;
CREATE INDEX "sesion_items_duplicado_al_enviar_idx" ON "sesion_items" USING btree ("courier_batch_id") WHERE duplicado_al_enviar;
CREATE INDEX "sesiones_escaneo_almacen_tipo_confirmed_at_idx" ON "sesiones_escaneo" USING btree ("almacen_id","tipo","confirmed_at");
CREATE INDEX "sesiones_escaneo_esperando_sync_idx" ON "sesiones_escaneo" USING btree ("almacen_id","barco_odoo_id") WHERE estado = 'confirmada_pendiente_sync';
COMMIT;
```

- [ ] Rama de Neon (copia de prod): aplicado sin errores. Resultado: ______
- [ ] En la rama, `EXPLAIN ANALYZE` de Enviadas hoy (`almacen_id`, `tipo = 'recepcion'`, `confirmed_at >= hoy`) usa `sesiones_escaneo_almacen_tipo_confirmed_at_idx`. Resultado: ______
- [ ] Prod: mismo SQL, sin errores. Resultado: ______

Referencia, con un año de datos sintéticos en Postgres 16 (60k sesiones, 200k paquetes): el conteo de Pendientes bajó de 3,2 s a 15 ms, y Enviadas hoy de 8 ms a 0,1 ms.

---

## 6. Fuera del código

- Neon: si el plan lo permite, alargar o desactivar el *scale to zero* en horario laboral. El primer request después de 5 minutos sin uso paga el arranque del compute.
