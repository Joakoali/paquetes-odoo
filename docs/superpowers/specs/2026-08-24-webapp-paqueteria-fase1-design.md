# Webapp de Paquetería — Diseño Fase 1

**Fecha:** 2026-08-24
**Estado:** Aprobado para pasar a plan de implementación
**Contexto de negocio:** ver `CONTEXTO-ODOO-WEBAPP.md` en la raíz del proyecto

## 1. Propósito y alcance

Marala Provisioning / BWA Yachting recibe paquetes de couriers dirigidos a barcos y los entrega agrupados en el yate. Hoy este flujo se gestiona directo en Odoo (app Barcode nativa + Studio), lo que produce errores recurrentes: tracking numbers duplicados que generan líneas fantasma, barcos duplicados, contaminación cross-warehouse en fusiones de entregas, y falta de visibilidad de qué quedó en depósito. El detalle de estos incidentes y las reglas de negocio ya validadas están en `CONTEXTO-ODOO-WEBAPP.md`.

Esta webapp es una **capa de captura y validación** sobre Odoo — Odoo sigue siendo la única fuente de verdad para el estado de negocio (pickings, movimientos, lotes). La webapp existe para que la carga sea rápida, sin errores de tipeo/duplicados, y con trazabilidad de qué operario hizo qué.

**Fuera de alcance de este documento (fases futuras, sub-proyectos separados con su propio ciclo spec→plan→código):**
- Dashboard por barco (qué está pendiente de entrega / en depósito, por almacén).
- Herramienta de reparación (mover líneas entre pickings para deshacer fusiones incorrectas).

**Dentro de alcance de fase 1:**
- Recepción de paquetes (multi-courier por sesión).
- Entrega de paquetes al barco, con firma digital.
- Validación de duplicados de tracking number en el momento de la carga.
- Panel de administración mínimo: alta de operarios y asignación de almacenes por operario (prerequisito técnico para la restricción de acceso, no el dashboard completo).

## 2. Arquitectura general

- **Frontend + backend**: Next.js (TypeScript), desplegado en Vercel. El navegador nunca llama a Odoo directamente — todo pasa por Server Actions / API routes propias, que son las únicas que conocen el API key de Odoo.
- **Base de datos propia**: Postgres (Neon). Guarda todo lo que no es estado de negocio de Odoo: usuarios/operarios, sesiones de escaneo, caches de lectura rápida, cola de sincronización, log de auditoría.
- **Integración con Odoo**: cliente JSON-2 (`POST /json/2/<model>/<method>`, `Authorization: Bearer <api_key>`) usando **un único usuario de integración dedicado** en Odoo (no las credenciales compartidas humanas existentes). Todas las llamadas salen por una **cola global de un solo consumidor**, que fuerza ≤1 request/segundo sin paralelismo, sin importar cuántos operarios estén usando la webapp a la vez.
- **Fuente de verdad**: Odoo. La cache y las sesiones locales son solo para UX rápida — ningún dato de negocio confirmado vive únicamente en la webapp.

### Por qué este diseño se banca ~20 usuarios concurrentes

- Postgres/Neon no es un cuello de botella a esta escala — maneja la carga de 20 usuarios escaneando sin esfuerzo.
- El escaneo interactivo (agregar tracking numbers a una sesión) **nunca toca Odoo** — es 100% local contra la cache. El rate limit de Odoo solo afecta el paso de confirmación/sincronización, no la parte de mayor frecuencia.
- Cada sesión confirmada se traduce en **~5-10 llamadas a Odoo en total** (no una por paquete), gracias a creación en batch (`create` con lista de valores en una sola llamada).
- La confirmación es **asíncrona y no bloqueante**: el operario no espera a que la cola drene: la sesión se marca "sincronizando" al instante y el operario puede arrancar la siguiente sesión de inmediato. El peor caso (20 operarios confirmando al mismo instante, ~30 paquetes cada uno) son ~150-200 llamadas en cola (~2.5-3 min para drenar del todo), pero nadie se queda esperando eso — es trabajo en segundo plano.

**Punto a verificar más adelante (no bloquea el diseño):** no está confirmado si el rate limit de Odoo es global a la base o por API key. Si en el futuro hiciera falta más throughput, valdría la pena consultarlo con Vanesa (partner de Odoo) antes de asumir que agregar credenciales ayuda.

## 3. Modelo de datos propio (Postgres)

| Tabla | Propósito |
|---|---|
| `operarios` | Login propio de cada operario (separado de Odoo), rol (`operario` \| `admin`), activo/inactivo. |
| `operario_almacenes` | Relación operario↔almacén: qué `picking_type_id`/prefijo puede usar cada operario. Editable solo por admin. |
| `almacenes` | Cache de los 7 almacenes (prefijo, nombre, `picking_type_id` de Odoo). Cambia casi nunca. |
| `barcos_cache` | Cache de `project.project` (id Odoo, nombre) para el selector de barco. Refresco periódico. Crear barcos nuevos queda restringido a admin (evita duplicados tipo "MOONSHADOW", problema conocido #2). |
| `sesiones_escaneo` | Una sesión = operario + almacén + barco + tipo (`recepcion` \| `entrega`) + estado (`en_curso`, `confirmada_pendiente_sync`, `sincronizada`, `error`). |
| `sesion_items` | Cada tracking number escaneado dentro de una sesión, con courier asociado y estado individual (`ok`, `duplicado`, `sincronizado`, `error`). |
| `tracking_activos_cache` | Cache de tracking numbers ya existentes en Odoo (pickings no cancelados), para el chequeo instantáneo de duplicados durante el escaneo. Se actualiza write-through en cada sync exitosa. |
| `sync_queue` | Cola del worker único: qué sesión sincronizar, intentos, último error. |
| `audit_log` | Quién hizo qué acción y cuándo, independiente de lo que Odoo registra vía `message_post`. |

## 4. Flujos

### 4.1 Recepción

1. Login del operario → elige almacén (solo entre los que tiene asignados; si solo tiene uno, se preselecciona) → busca/selecciona el barco desde `barcos_cache`.
2. Arranca una sesión de recepción (barco + almacén). Dentro de la sesión, por cada **tanda de courier**:
   - Elige el courier (el "producto" en términos de Odoo — DHL, Amazon, GLS, etc.).
   - Escanea/ingresa tracking numbers en serie. Cada uno se valida al instante contra `tracking_activos_cache` + lo ya escaneado en la sesión; si es duplicado, alerta inmediata sin tocar Odoo. **No hay campo de cantidad esperada** — la cantidad es simplemente cuántos tracking numbers se escanearon (esto evita por diseño el bug de líneas fantasma por demanda≠cantidad, problema conocido #4).
   - Toca "Listo" → cierra esa tanda de courier, vuelve al selector para agregar otra tanda si hace falta (una sesión puede incluir varios couriers).
3. "Confirmar sesión" → pasa a `sync_queue`. El worker único:
   - Chequeo de duplicados en vivo contra Odoo (una sola llamada con todos los tracking numbers de la sesión) como red de seguridad final, por si algo se cargó fuera de la webapp mientras tanto.
   - Crea un `stock.picking` incoming **nuevo** para esta sesión (una sesión confirmada = un picking nuevo; no busca uno existente para agregarle líneas — más simple, y la fusión de entregas la sigue haciendo el cron ya validado en producción, sin que la webapp reimplemente esa lógica).
   - Por cada tanda de courier, crea un `stock.move` (producto = courier) con sus `stock.move.line` (una por tracking number, `lot_name` = tracking number), todo en **una sola llamada batch** por picking.
   - Confirma y valida el picking → dispara el cron existente que genera/fusiona la entrega `outgoing`.
   - Marca la sesión como sincronizada, actualiza `tracking_activos_cache` (write-through), deja `message_post` en el picking ("Registrado vía Webapp Paquetería por `<operario>`"), escribe `audit_log`.

### 4.2 Entrega (con firma digital)

1. Operario elige almacén + barco → lectura **en vivo** a Odoo (una sola llamada puntual, no hace falta cache — esto no es un loop de alta frecuencia como el escaneo) trayendo las entregas `outgoing` pendientes de ese barco+almacén con sus tracking numbers.
2. Operario marca qué se entrega (por default todo; permite entrega parcial → backorder nativo, igual que el comportamiento actual).
3. Captura firma digital (canvas táctil) del receptor en el barco.
4. Confirma → sesión tipo entrega entra a la misma `sync_queue`: valida el/los picking(s) en Odoo, escribe `signature`/`is_signed`, deja backorder si fue parcial, `message_post` + `audit_log`.

La generación e impresión del albarán **no** se reemplaza — sigue el proceso actual fuera de la webapp.

## 5. Manejo de errores

- Si la sincronización de una sesión falla (Odoo caído, timeout, conflicto), la sesión queda en estado `error`, visible en una vista de "pendientes de atención"; reintento automático con backoff + reintento manual disponible.
- **El trabajo escaneado nunca se pierde** — vive en Postgres desde el momento en que se escanea, independientemente de si la sincronización con Odoo tuvo éxito.
- Nunca `unlink()` sobre pickings — siempre `action_cancel()` (regla ya establecida, ver `CONTEXTO-ODOO-WEBAPP.md` §10).
- Toda operación masiva queda loggeada tanto localmente (`audit_log`) como en Odoo (`message_post`), mismo criterio que el cron actual.
- Toda escritura contra Odoo se prueba primero contra la base de **test**, nunca directo en producción.

## 6. Permisos y administración

- Cada operario tiene login individual propio de la webapp (no reutiliza usuarios de Odoo — hoy los operarios no tienen usuario individual ahí).
- Un admin (vos) gestiona desde un panel simple: alta/baja de operarios, y qué almacenes puede usar cada uno (`operario_almacenes`). Esta restricción vive enteramente en la webapp; Odoo no tiene noción de ella — la webapp siempre le habla a Odoo con el mismo usuario de integración dedicado.
- Creación de barcos nuevos restringida a admin, para evitar duplicados.

## 7. Testing

- **Cliente Odoo (cola, batching, rate limit)**: unit tests con Odoo mockeado.
- **Integración real**: solo contra la base de test de Odoo, nunca producción.
- **Detección de duplicados**: tests con fixtures para los casos borde — duplicado dentro de la misma sesión, duplicado ya existente en Odoo, duplicado que aparece justo antes de confirmar (chequeo en vivo final).
- **UI de escaneo**: prueba manual con lector de código de barras real (emula teclado, sin lógica especial de la webapp más que un input con foco) y con cámara, en al menos un dispositivo de cada tipo, antes de cerrar la fase 1.

## 8. Preferencias de código (heredadas del contexto del proyecto)

- TypeScript con tipado explícito.
- Funciones de 1-2 parámetros; con 3 o más, definir una interfaz/estructura.
- Documentar solo lo complejo, no lo trivial.
- Evitar duplicación; priorizar legibilidad sobre atajos.
