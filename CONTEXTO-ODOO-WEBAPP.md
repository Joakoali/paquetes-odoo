# Contexto para desarrollo de webapp conectada a Odoo

## 1. Negocio

Empresa de provisioning/logística para yates (Marala Provisioning / BWA Yachting). El flujo central es:

1. Llegan paquetes de couriers (Amazon, Correos, DHL, GLS, SEUR, PAACK, MRW, CTT Express, UPS, BPOST, FedEx, Deutsche Post, Royal Mail...) dirigidos a un **barco**.
2. Se registran en Odoo como **recepciones** (`stock.picking` tipo `incoming`), con el barco y el tracking number de cada paquete.
3. Odoo genera automáticamente una **orden de entrega** (`stock.picking` tipo `outgoing`) por cada recepción validada.
4. Un cron agrupa todas las entregas pendientes del mismo barco en una sola orden, para entregar todo junto al yate.
5. Al entregar, se firma digitalmente y se imprime un albarán con todos los paquetes y sus tracking numbers.

**Concepto clave:** un "producto" en Odoo aquí no es un artículo, es **el courier**. Cada paquete físico es una línea de movimiento (`stock.move.line`) con su tracking number guardado como lote/serie.

## 2. Entorno técnico

- **Odoo 19**, hosting Odoo Online (SaaS), plan **Custom** (Studio habilitado, API externa disponible).
- Dos bases: **producción** y **test**. Los nombres de campos custom **difieren entre entornos** (ver sección 4).
- API externa disponible, API Key generable desde Preferencias → Seguridad de la cuenta.
- Rate limit aproximado: 1 llamada/segundo, sin llamadas en paralelo.
- **XML-RPC y JSON-RPC clásico están deprecados** (retiro previsto en Odoo 20, fines de 2026). Para desarrollo nuevo usar **JSON-2** (`POST /json/2/<model>/<method>`, auth con `Authorization: Bearer <api_key>`).

## 3. Almacenes

Cada almacén tiene su propio `picking_type_id` y prefijo de secuencia:

| Prefijo | Almacén                      |
| ------- | ---------------------------- |
| MB92    | Barcelona (MB92)             |
| IBZ     | Ibiza / Baleares             |
| MPV     | Marina Port Vell (Barcelona) |
| VLN     | Pendennis Vilanova           |
| MLC     | (Mallorca)                   |
| MLR     | (Mallorca)                   |
| MLG     | (Málaga)                     |

**Regla crítica:** cualquier lógica que agrupe por barco DEBE filtrar también por `picking_type_id`. Barcos como ARCTIC reciben paquetes en varios almacenes simultáneamente; agrupar solo por barco mezcló entregas de Ibiza dentro de una entrega de Barcelona (incidente real, ver sección 7).

## 4. Modelos y campos

### Modelos relevantes

- `stock.picking` — recepciones y entregas (el documento)
- `stock.move` — línea de producto planeada dentro del picking
- `stock.move.line` — detalle real; **aquí vive el tracking number** (`lot_id` / `lot_name`)
- `project.project` — los barcos
- `stock.lot` — lotes/series (tracking numbers)

### Campos custom (Studio) en `stock.picking`

| Concepto                             | Producción                | Test                    |
| ------------------------------------ | ------------------------- | ----------------------- |
| Barco (Many2one → `project.project`) | `x_studio_barco`          | `x_studio_barco_4`      |
| Recibido por (texto)                 | `x_studio_recibido_por_2` | `x_studio_recibido_por` |

⚠️ No asumir nombres: verificar siempre contra el entorno antes de escribir queries.

### Campos nativos usados

- `picking_type_id` — tipo de operación (identifica el almacén)
- `picking_type_code` — `'incoming'` / `'outgoing'` (genérico, NO distingue almacén)
- `state` — `draft`, `waiting`, `confirmed`, `assigned`, `done`, `cancel`
- `move_ids`, `move_line_ids`, `move_orig_ids` (encadenamiento recepción→entrega)
- `origin` — documento de origen
- `signature`, `is_signed`

## 5. Restricciones no negociables

- **`partner_id` está prohibido** para identificar barcos. Contabilidad lo usa para razones fiscales (el barco "Mayan Queen" factura como "Queen Mayan LTD"). Además una misma owning company puede tener varios barcos. En el formulario de picking de test está forzado a `invisible`.
- **`group_id` NO existe en `stock.picking`** en esta instalación. Solo existe en `stock.move`. Confirmado por error de validación de vista.
- **Presupuesto de código custom limitado**: el contrato con Odoo incluye ~100 líneas de código custom/año (gestionado vía Vanesa, la partner). Automatizaciones, server actions y campos calculados de Studio cuentan. Preferir siempre solución nativa o lógica en la webapp externa antes que sumar código dentro de Odoo.

## 6. Lógica actual del cron (producción)

Scheduled Action, corre cada 1 minuto:

```python
entregas = env['stock.picking'].search([
    ('picking_type_code', '=', 'outgoing'),
    ('x_studio_barco', '=', False),
    ('state', 'not in', ['draft', 'done', 'cancel'])
])
for entrega in entregas:
    recepciones = entrega.move_ids.move_orig_ids.picking_id.filtered(
        lambda p: p.picking_type_code == 'incoming' and p.x_studio_barco
    )
    if not recepciones:
        continue
    barco = recepciones[0].x_studio_barco
    entrega.write({'x_studio_barco': barco.id})
    entrega_existente = env['stock.picking'].search([
        ('picking_type_id', '=', entrega.picking_type_id.id),
        ('x_studio_barco', '=', barco.id),
        ('state', 'not in', ['draft', 'done', 'cancel']),
        ('id', '!=', entrega.id),
    ], order='id asc', limit=1)
    if entrega_existente:
        entrega.move_ids.write({'picking_id': entrega_existente.id})
        entrega.move_line_ids.write({'picking_id': entrega_existente.id})
        entrega_existente.message_post(body="Se fusionaron paquetes de la entrega " + entrega.name + " (barco " + barco.name + ").")
        entrega.action_cancel()
```

Decisiones de diseño ya tomadas:

- `action_cancel()` en vez de `unlink()` — red de seguridad tras una pérdida de datos real.
- Mover **ambos**: `move_ids` y `move_line_ids`. Mover solo `move_ids` pierde los tracking numbers en el PDF.
- Excluir `draft` — el cron llegó a inyectar líneas en entregas borrador creadas por error a mano.
- Solo procesa entregas **sin barco asignado**. Una vez que una entrega tiene barco, el cron ya no la vuelve a evaluar (decisión consciente, para mantener la lógica simple).

## 7. Problemas conocidos (útiles como casos de uso para la webapp)

1. **Contaminación cross-warehouse**: un segundo cron de "limpieza periódica" sin filtro de `picking_type_id` fusionó entregas de IBZ dentro de MB92/OUT/00069 (19 líneas mezcladas de dos almacenes). Pendiente de deshacer manualmente.
2. **Barcos duplicados**: el campo Barco permite crear registros al vuelo; aparecieron dos "MOONSHADOW" con IDs distintos, que nunca se agrupan entre sí. Falta poner `no_create` en el selector.
3. **Race condition**: dos entregas del mismo barco creadas casi simultáneamente a veces no se fusionan y quedan ambas pendientes. Se resuelve a mano.
4. **Líneas duplicadas**: cargar dos veces el mismo paquete deja una línea fantasma (demanda 1, cantidad 0) que bloquea la validación del picking y no se puede borrar desde el formulario.
5. **Sin visibilidad de "en depósito"**: cuando un barco pide dejar paquetes en almacén, se usa backorder nativo, pero no hay una vista clara de qué está esperando por barco.
6. **Trazabilidad manual**: identificar de qué recepción/almacén vino cada línea de una entrega fusionada requiere navegar picking por picking.

## 8. Objetivos candidatos para la webapp

A definir, pero el dolor real está en:

- **Interfaz de recepción rápida** con lector de código de barras/QR: escanear barco → escanear paquetes en serie, evitando la carga manual y los duplicados. Reemplazaría la app Barcode nativa (que no maneja bien el campo custom de barco).
- **Dashboard por barco**: qué hay pendiente de entregar, qué quedó en depósito, en qué almacén, con tracking numbers.
- **Validación previa**: detectar tracking numbers duplicados antes de que entren al sistema.
- **Herramienta de reparación**: mover líneas entre pickings (reasignar `picking_id` de `stock.move` + `stock.move.line`) para deshacer fusiones incorrectas, sin tocar la UI de Odoo.

## 9. Preferencias de código

- Tipado explícito (TypeScript si es JS).
- Funciones de 1-2 parámetros; con 3 o más, definir una interfaz/estructura.
- Documentar solo lo complejo, no lo trivial.
- Soluciones estructuradas y escalables, no hacks temporales.
- Evitar duplicación; buscar modularidad y reutilización.
- Preferir legibilidad sobre atajos.

## 10. Reglas de seguridad para el desarrollo

- Toda escritura contra Odoo se prueba primero en la **base de test**, nunca directo en producción.
- Nunca `unlink()` sobre pickings desde la webapp. Usar cancelación.
- Cualquier operación masiva debe ser idempotente y loggear qué tocó (equivalente al `message_post` del cron).
- Respetar el rate limit: sin llamadas en paralelo, throttling a ~1/seg.
