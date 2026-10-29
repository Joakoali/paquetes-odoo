# Runbook — Búsqueda por tracking nº (despliegue y QA)

> **Fecha:** 2026-10-29
> **Alcance:** desplegar la búsqueda por tracking nº (rama `claude/youthful-hawking-ciqpqn`), aplicar la migración `0004` y verificar con dispositivos reales lo que los tests no cubren: la pistola, el móvil y Odoo de producción.
> **Reglas:** las de §0 de `2026-10-22-qa-mejora-ui.md`. Barco de QA: APHRODITE (id 474), almacén MB92, códigos inventados `QA-…`. La búsqueda **solo lee** Odoo. Lo único que escribe es la entrega de QA de §4, y eso ya se escribía antes.

---

## 1. Qué cambia

| Commit | Cambio | Riesgo |
| --- | --- | --- |
| `217f37d` | Filtro por tracking nº en las listas: los paquetes de un barco en Entrega, los de una recepción (abierta o enviada) y las tarjetas de Pendientes. El `q` de la dirección abre la lista ya filtrada. | Bajo. En la tablet el filtro convive con la pistola (§3). |
| `4df8be9` | Cada entrega guarda qué paquetes entregó (`paquetes_entrega`, migración `0004`). Pendientes lista los tracking de una entrega. | Bajo. **`0004` va antes del deploy** (§5). |
| `42fb0fa` | Pestaña **Buscar**: dónde está un paquete, en la webapp y en Odoo (2 lecturas por búsqueda, solo al buscar), de todos los almacenes, y solo se abre lo que el operario tiene permitido. Además: "Buscar «X» como tracking nº" en los buscadores de barcos, `/buscar` detrás del proxy y las 5 pestañas del admin. | Bajo. Solo lee Odoo. |

---

## 2. Orden

1. Aplicar la migración `0004` (§5). Va **antes** del deploy: el código nuevo guarda esa columna en cada entrega. El código anterior no la conoce y la ignora, así que migrar primero es seguro.
2. Desplegar desde la rama (o desde `mejora-ui-revision`, si el PR ya se mergeó):

   ```powershell
   git fetch origin claude/youthful-hawking-ciqpqn
   git switch --detach origin/claude/youthful-hawking-ciqpqn
   vercel --prod
   ```

3. Los chequeos de §3 y la entrega de QA de §4.

---

## 3. Chequeos

### Buscar

- [ ] **Tablet con la pistola**, pestaña Buscar: escanear un paquete conocido (un tracking real reciente de MB92). Aparece su recorrido. Escanear otro enseguida: el segundo código reemplaza al primero en el campo, no se pega. Resultado: ______
- [ ] **Móvil:** escribir los últimos 4–6 dígitos de un paquete que espera entrega en MB92. Tiene que aparecer "Recibido…" y "Esperando entrega · MB92/OUT/…", con su barco y "Abrir ›". "Abrir" lleva al barco con la lista ya filtrada en ese paquete. Resultado: ______
- [ ] Un paquete **cargado a mano en Odoo** (no por la webapp) aparece igual, como "Recibido en Odoo". Resultado: ______
- [ ] Un paquete **de otro almacén** (por ejemplo IBZ) aparece con su almacén y su barco, sin "Abrir". Resultado: ______
- [ ] Un paquete **ya entregado** aparece como "Entregado · ✓ MB92/OUT/… · recibió <nombre>". Resultado: ______
- [ ] Con **menos de 4 caracteres** dice "Escribí al menos 4 caracteres", y en DevTools → Network no hay lectura de Odoo. Resultado: ______
- [ ] **Tiempos:** una búsqueda tarda ≈ 1–2 s (son dos lecturas a Odoo). Mientras tanto el campo sigue en pantalla, con "Buscando en la webapp y en Odoo…". Resultado: ______
- [ ] En el inicio de **Entrega**, escribir un tracking en "Buscar barco…": aparece "Buscar «X» como tracking nº ›", que lleva a Buscar. Lo mismo en el buscador del inicio de **Recepción**. Resultado: ______

### Filtros

- [ ] **Recepción de QA en la tablet**, con 3–4 paquetes `QA-…`:
  - tocar el filtro y escribir parte de un código: queda solo ese paquete;
  - sin tocar nada más (el foco sigue en el filtro), escanear con la pistola: el código se usa como filtro, no se agrega y no suena el "ok";
  - tocar cualquier otra parte de la pantalla: el foco vuelve al campo de escaneo.

  Resultado: ______
- [ ] Con un filtro puesto, escanear por el **campo de escaneo**: el filtro se limpia y el paquete nuevo aparece arriba, con "✓ … agregado". Resultado: ______
- [ ] **Entrega en el móvil**, en un barco con 6 o más paquetes: filtrar uno, desmarcarlo ("en depósito") y quitar el filtro. Todos siguen marcados salvo ese, y "Siguiente: firma" cuenta todos los marcados. Resultado: ______
- [ ] **Pendientes** (con 6 o más problemas, o entrando por `/pendientes?q=…`): el filtro deja solo las tarjetas que tienen ese paquete. Resultado: ______

### Pestañas

- [ ] **Admin en el móvil:** entran las 5 pestañas, y el número de Pendientes no tapa "Buscar". Resultado: ______
- [ ] **Admin en una tablet vertical (768 px):** las pestañas no se pisan con el almacén ni con el nombre. El nombre se corta con "…". Resultado: ______

Referencia: se revisó en Chromium a 360, 768 y 1024 px, sin desbordes ni pestañas superpuestas.

---

## 4. Entrega de QA: lo que guarda

- [ ] Entregar 1–2 paquetes del barco de QA en MB92. Después, en Neon:

  ```sql
  select paquetes_entrega from sesiones_escaneo where tipo = 'entrega' order by confirmed_at desc limit 1;
  ```

  Tienen que aparecer el tracking, el courier y el albarán de cada paquete entregado. Resultado: ______
- [ ] Enseguida, mientras se envía, buscarlo en Buscar. Tiene que decir "Entregado · … · enviándose a Odoo", **no** "Esperando entrega". Alrededor de un minuto después: "✓ MB92/OUT/…". Resultado: ______

---

## 5. Migración `0004`

Producción no tiene tabla de migraciones: se aplica a mano, primero en una rama de Neon.

```sql
ALTER TABLE "sesiones_escaneo" ADD COLUMN "paquetes_entrega" jsonb;
```

Agregar una columna que admite null y no tiene default no reescribe la tabla, así que es instantáneo.

- [ ] Rama de Neon (copia de prod): aplicado sin errores. Resultado: ______
- [ ] Prod: mismo SQL, sin errores. Resultado: ______

---

## 6. Si algo sale mal

`vercel rollback` vuelve al deploy anterior. La columna de `0004` puede quedar: el código anterior la ignora.

---

## 7. Notas

- **Entregas anteriores a este deploy:** no guardaron sus paquetes. Buscar y Pendientes no encuentran un paquete dentro de ellas, aunque Odoo sí lo muestra.
- **Rendimiento:** la búsqueda en la webapp recorre `sesion_items` entera, porque un `LIKE` con comodín al principio no usa índices. Con las tablas de hoy no se nota. Si llegan a cientos de miles de paquetes, la solución es un índice trigram (`pg_trgm`) sobre `regexp_replace(lower(tracking_number), '[[:space:]]', '', 'g')`.
