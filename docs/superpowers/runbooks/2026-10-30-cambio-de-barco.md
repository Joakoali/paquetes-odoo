# Runbook — Mover paquetes a otro barco (despliegue y QA)

> **Fecha:** 2026-10-30
> **Alcance:** desplegar el cambio de barco (rama `claude/youthful-hawking-ciqpqn`), aplicar la migración `0005` y verificarlo contra Odoo de producción con barcos de QA.
> **Reglas:** las de §0 de `2026-10-22-qa-mejora-ui.md`. Esta funcionalidad **escribe en Odoo**: mueve movimientos y líneas de una entrega a otra, como hace el cron cuando fusiona entregas. Todo se prueba con barcos de QA, en MB92 y con códigos inventados `QA-…`.

---

## 1. Qué cambia

| Commit | Cambio | Riesgo |
| --- | --- | --- |
| `0e170fb` | Cómo se mueven paquetes entre las entregas de dos barcos en Odoo (`lib/odoo/reasignacion.ts`). | **Medio.** Escribe en Odoo de producción. Para mover parte de un movimiento lo parte con escrituras que la webapp no usaba hasta ahora (ver §4.2). Si Odoo no lo parte como se espera, el worker se detiene antes de mover nada. |
| `a0aa141` | Botón "Mover paquetes a otro barco" en Entrega › barco, la acción, el worker, Pendientes, Buscar y la migración `0005`. | Bajo. Sigue el mismo camino que una entrega: cola `odoo-sync`, reintentos y Pendientes. **`0005` va antes del merge** (§2). |

**Decisiones tomadas:**
- Solo se mueven paquetes que ya están en Odoo esperando entrega. En una recepción abierta se sigue como hoy: ✕ y volver a escanear.
- Solo se tocan las entregas. La recepción (IN) queda con el barco con el que se recibió.
- Lo puede hacer cualquier operario del almacén activo.

---

## 2. Orden

1. Aplicar la migración `0005` (§5) **antes de mergear el PR**.
   - **Por qué antes:** mergear en `mejora-ui-revision` despliega producción. Sin el valor `reasignacion` del enum y sin la columna nueva fallarían el botón de mover, Pendientes, Buscar y las pantallas de un barco: todas leen esas sesiones.
   - **Por qué es seguro hacerlo primero:** el código anterior no conoce ni el valor ni la columna, y los ignora.
2. Mergear el PR y comprobar en Vercel que el deploy de producción sea el del merge commit y que haya terminado. Si la rama de producción de Vercel no es `mejora-ui-revision`, desplegar a mano como en `2026-10-29-busqueda-tracking.md` §2.
3. Hacer los chequeos de §3 y el QA de §4.

---

## 3. Chequeos de pantalla (no escriben en Odoo hasta confirmar)

- [ ] **Móvil**, Entrega › barco de QA con varios paquetes:
  - al final de la lista, arriba de "Siguiente: firma", aparece **"Mover paquetes a otro barco ›"**;
  - al tocarlo, se abre la lista de paquetes sin ninguno marcado;
  - "Elegir el barco" queda deshabilitado hasta marcar uno;
  - el filtro por tracking nº funciona.

  Resultado: ______
- [ ] En "¿A qué barco van?", el buscador **no ofrece el barco en el que están los paquetes**. Los barcos con nombre repetido salen con su id (`H3 · #935`). Resultado: ______
- [ ] "‹ Cancelar" vuelve a la entrega con la selección tal como estaba (los paquetes dejados "en depósito" siguen así). Resultado: ______

---

## 4. QA contra Odoo de producción

**Barcos:**
- A = APHRODITE (474).
- B = un segundo barco de QA, sin entregas pendientes en MB92: ______ (id ______).

**Dónde mirar en Odoo:**
- La entrega: pestaña "Operaciones" con la demanda y la cantidad de cada movimiento, y "Operaciones detalladas" con los lotes.
- Los movimientos de origen de un movimiento: hace falta el modo desarrollador.

### 4.1 Preparación

- [ ] Recibir para A **3 `QA-DHL`** (`QA-DHL-101..103`) y **2 `QA-GLS`** (`QA-GLS-101..102`) y enviar la recepción. Esperar unos 2 minutos, hasta que el cron arme la entrega de A. En el móvil, A tiene que mostrar los 5 paquetes. Entrega de A: ______

### 4.2 Mover parte de un movimiento (el caso delicado)

- [ ] Mover **`QA-DHL-102`** a B. Como B no tiene entrega, la webapp crea una.
- [ ] **En el móvil:**
  - enseguida, A muestra 4 paquetes y la franja "1 paquete pasándose a B";
  - unos 10 s después, al volver a abrir A, ya no aparece la franja;
  - B aparece en la lista de Entrega con 1 paquete.

  Resultado: ______
- [ ] **En Odoo, la entrega de A:**
  - el movimiento DHL tiene **demanda 2 y cantidad 2**, con `QA-DHL-101` y `QA-DHL-103`;
  - el GLS no cambió;
  - la entrega sigue en estado **Preparado**;
  - el chatter dice "Se pasaron 1 paquete(s) a B (…) vía Webapp Paquetería por …".

  Resultado: ______
- [ ] **En Odoo, la entrega nueva de B:**
  - origen "Webapp: cambio de barco", barco B y el tipo de entrega de MB92;
  - un movimiento DHL con **demanda 1 y cantidad 1**, el lote `QA-DHL-102`, estado **Preparado**;
  - en modo desarrollador, su movimiento de origen es el DHL de la recepción;
  - nota en el chatter.

  Referencia: ______
- [ ] **En Odoo, el lote `QA-DHL-102`:** sigue en `MB92/Stock`, reservado una sola vez (no aparece reservado dos veces ni sin reservar). Resultado: ______
- [ ] **En Neon:**

  ```sql
  select estado, odoo_picking_ref, ultimo_error from sesiones_escaneo where tipo = 'reasignacion' order by confirmed_at desc limit 1;
  ```

  Tiene que dar `sincronizada`, la referencia de la entrega de B y `ultimo_error` vacío. Resultado: ______

### 4.3 Mover movimientos enteros

- [ ] Mover los dos `QA-GLS` a B:
  - el movimiento GLS pasa **entero** a la **misma** entrega de B (la pendiente más vieja de B, como haría el cron);
  - A se queda solo con DHL (2);
  - notas en las dos entregas.

  Resultado: ______

### 4.4 Vaciar la entrega de A

- [ ] Mover `QA-DHL-101` y `QA-DHL-103` a B:
  - la entrega de A queda vacía y **se cancela**, con la nota "…La entrega quedó vacía y se canceló.";
  - A desaparece de la lista de Entrega.

  Resultado: ______

### 4.5 Dejar en depósito un paquete movido

- [ ] Entregar B en el móvil dejando `QA-DHL-102` en depósito:
  - el backorder de B tiene **exactamente** `QA-DHL-102`, reservado y con el barco B;
  - esto prueba que el movimiento partido conservó su movimiento de origen.

  Backorder: ______

### 4.6 Entregar y mover enseguida

- [ ] Recibir para A **2 `QA-DHL`** (`QA-DHL-201..202`), enviar y esperar a la entrega de A.
- [ ] Entregar A dejando `QA-DHL-202` en depósito. **Enseguida**, antes de que pase un minuto, moverlo a B:
  - el cambio de barco termina `sincronizada` igual;
  - `QA-DHL-202` está en la entrega de B.

  Al validar la entrega, Odoo recrea la línea en un backorder con otro id, y el worker la encuentra por su lote. Resultado: ______

### 4.7 Buscar

- [ ] Buscar `QA-DHL-102`. Tienen que aparecer:
  - "Recibido · APHRODITE";
  - "Cambiado de barco · MB92 · APHRODITE → B · ✓ MB92/OUT/…";
  - la entrega de B.

  Resultado: ______

### 4.8 Limpieza

- [ ] Entregar o cancelar lo que quedó de QA en A y en B, y sacar el stock `QA-` con un ajuste de inventario (como en §8 de `2026-10-22-qa-mejora-ui.md`). Resultado: ______

---

## 5. Migración `0005`

Producción no tiene tabla de migraciones: se aplica a mano, primero en una rama de Neon.

```sql
ALTER TYPE "public"."tipo_sesion" ADD VALUE 'reasignacion';
ALTER TABLE "sesiones_escaneo" ADD COLUMN "barco_destino_odoo_id" integer;
```

- Las dos sentencias son instantáneas: ninguna reescribe la tabla.
- `ADD VALUE` puede ir dentro de una transacción (Postgres 12 o más; Neon usa 16 o 17) mientras el valor nuevo no se use en esa misma transacción.

- [ ] Rama de Neon (copia de prod): aplicado sin errores. Resultado: ______
- [ ] Prod: mismo SQL, sin errores. Resultado: ______

---

## 6. Si algo sale mal

- **Volver al deploy anterior:** `vercel rollback`. La migración `0005` puede quedar: el código anterior la ignora.
  - Si quedó un cambio de barco en la cola, el worker anterior lo trata como una entrega y falla antes de llamar a Odoo, porque no tiene firma.
  - Queda en Pendientes. Con el deploy nuevo de vuelta, "Reintentar" lo completa.
- **Un cambio de barco en Pendientes:** cada escritura en Odoo es una sola transacción y deja las entregas enteras, así que nunca queda algo movido a medias. "Reintentar" sigue desde donde quedó. El detalle dice qué pasó:
  - "**ya no están esperando entrega de este barco**": alguien entregó o movió el paquete en Odoo en el medio. No se movió nada.
  - "**a medio reservar**": el movimiento tiene demanda sin reservar. Hay que revisarlo en Odoo. No se movió nada.
  - "**Odoo no separó los paquetes de su movimiento**": la partición (§4.2) no quedó como se esperaba, y no se pasó nada al otro barco. Revisar el movimiento en la entrega de A. Ese caso se corrige con su test y su commit antes de volver a usarlo.
- **Deshacer un cambio de barco:** mover los paquetes de vuelta, de B a A, con el mismo botón.

---

## 7. Notas

- **Requests:** cada cambio de barco son de 7 a 9 requests a Odoo (unos 7–9 s), siempre por la cola. Mientras tanto, los paquetes no se ofrecen para entregar en A ("pasándose a B").
- **Notas en Odoo:** cada corrida del worker anota lo que hizo. Si una corrida se corta entre las dos notas y se reintenta, la segunda nota no se escribe. Pasa lo mismo con las entregas.
- **Qué no cubre:**
  - paquetes ya entregados;
  - mover entre almacenes (el paquete está físicamente en uno);
  - la recepción abierta: los paquetes todavía no están en Odoo.
