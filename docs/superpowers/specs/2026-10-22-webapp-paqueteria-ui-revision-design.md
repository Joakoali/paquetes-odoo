# Webapp de Paquetería — Mejora de interfaz y revisión

**Fecha:** 2026-10-22
**Estado:** Para aprobación del usuario (revisado por un builder; preguntas respondidas)
**Se apoya en:** la Fase 1 (`2026-08-24-webapp-paqueteria-fase1-design.md`). Contexto de negocio y reglas de Odoo en `CONTEXTO-ODOO-WEBAPP.md`.
**Bocetos aprobados** (abrir en el navegador): `docs/superpowers/specs/mockups/2026-10-22-recepcion-tablet.html` y `docs/superpowers/specs/mockups/2026-10-22-entrega-movil.html`.

**Convención:** lo que no lleva marca lo dijo o lo aprobó el usuario. **[decisión de Claude]** marca lo que decidí yo sin que el usuario lo discutiera; el usuario puede revisarlo. Los datos de Odoo citados se verificaron el 2026-10-22 con lecturas a producción (ver Anexo A).

---

## 1. Por qué

La Fase 1 funciona de punta a punta contra Odoo producción: la primera recepción real se validó el 2026-09-22. Pero nadie la usa todavía en el día a día. Todo lo hecho hasta hoy fueron pruebas: 8 recepciones y 0 entregas. Antes de pasársela a los operarios hacen falta dos cosas:

1. **Una interfaz que se pueda usar en los dispositivos reales.** Hoy es HTML sin estilo, pensado para escritorio, y tiene trampas. El botón "Confirmar sesión" no aparece hasta que se toca "Listo", y en las pruebas 6 de 8 sesiones quedaron sin enviar. Un doble toque crea dos sesiones. El buscador muestra barcos repetidos sin forma de distinguirlos.
2. **Arreglar lo que encontró la revisión de la webapp** (§6). La lista de couriers está mal mapeada y le faltan casi todos, Odoo recibe UUIDs en vez de nombres, un error de sincronización traba la cola de todos y la entrega no encontraría nada pendiente, entre otras cosas.

Lo que pidió el usuario: "mejorar la interfaz, sobre todo; mantenerla simple pero mejorarla", y revisar qué más hay que mejorar en la webapp.

## 2. Cómo se trabaja, según el usuario

- **Recepción.** Llegan paquetes de distintos couriers. Se identifica a qué barco va cada uno y se registra. A veces se registran apenas llegan; otras veces se acumulan y "sería ideal entrarlos todos juntos". La unidad es el barco: la recepción de un barco puede tener paquetes de varios couriers.
- **Puesto de recepción:** una tablet (solo WiFi, sin SIM) con una pistola lectora de códigos de barras y QR, conectada por Bluetooth. La pistola funciona como teclado: escribe el código y aprieta Enter.
- **Entrega.** Se juntan los paquetes y se llevan al barco. Ahí se le pide el nombre al crew que los recibe y que firme. Después, Odoo genera el albarán. En el barco la tablet no tiene cobertura, así que **la entrega se hace con el móvil del operario**, que tiene datos.
- **Problemas de sincronización:** hoy los resuelve el admin (Joaquín), pero la idea es ir delegándolos a los operarios.
- Cada operario entra con su propio usuario, también en la tablet compartida.
- Hoy, cuando cargan una recepción a mano en Odoo, en "Recibido por" escriben el nombre de pila del operario (por ejemplo, "Veronika" en `MB92/IN/00497`).

## 3. Objetivos, no objetivos y anti-objetivos

**Objetivos**
- Registrar una caja suelta en segundos, o una pila acumulada de varios barcos de una sola vez, con la pistola y sin tocar la pantalla entre paquete y paquete.
- Entregar desde el móvil en tres pasos: elegir el barco, revisar los paquetes (dejando en depósito lo que haga falta) y tomar el nombre y la firma del crew.
- Que el trabajo escaneado nunca quede olvidado ni trabado sin que nadie lo vea.
- Que los problemas los pueda entender y resolver alguien que no sea el admin.
- Que lo que llega a Odoo sea correcto y legible: el courier correcto, nombres en vez de UUIDs.

**No objetivos (quedan afuera)**
- El dashboard por barco y la herramienta de reparación. Siguen siendo fases futuras.
- Un modo sin conexión: se asume que el móvil tiene datos en el puerto.
- Escanear paquetes al preparar o al hacer la entrega. El usuario dijo: "si bien es organizado, no lo van a hacer".
- Escanear con la cámara del dispositivo. Para eso está la pistola. **[decisión de Claude]**
- Generar o imprimir el albarán desde la webapp. Lo sigue haciendo Odoo.
- Cambios dentro de Odoo (automatizaciones, server actions, campos nuevos), para cuidar el presupuesto de código custom. La única excepción: agregar con Studio "Recibido por" debajo de la firma del albarán (ver §5.3 y §8). Es una tarea del usuario, no código de la webapp.
- Librerías de interfaz nuevas.

**Anti-objetivos (sería un fracaso aunque funcione)**
- Que la interfaz se complique: más pantallas, más pasos o más conceptos que hoy. El operario solo tiene que pensar en barcos y paquetes, no en "tandas" ni "sesiones".
- Que el Enter de la pistola apriete un botón por accidente, por ejemplo "Enviar a Odoo".
- Que se pierda un escaneo porque la pistola disparó rápido.
- Que un error en una recepción frene las de todos.

## 4. Restricciones (no negociables)

Vienen de la Fase 1 (`CONTEXTO-ODOO-WEBAPP.md` §5 y §10) y de lo aprendido en producción:

- Nunca `unlink()` sobre pickings de Odoo: solo `action_cancel()`.
- Odoo admite ≤1 request por segundo, sin paralelismo, para toda la instancia. Todas las escrituras van por la cola QStash `odoo-sync` (`parallelism: 1`). Fuera de la cola solo se permiten lecturas puntuales (chequeo de duplicados, lectura de entregas pendientes), nunca en loop.
- La API es JSON-2 con body plano, vía `odooCall` (`lib/odoo/client.ts`).
- Los campos custom se leen de variables de entorno (`ODOO_FIELD_BARCO`, `ODOO_FIELD_RECIBIDO_POR`); nunca se hardcodean.
- Los barcos son `project.project` y está prohibido usar `partner_id`. Todo lo que agrupe por barco filtra también por almacén / tipo de operación.
- Odoo 19 (saas-19.3) tiene particularidades: `stock.move` no tiene `name`, y `location_id`/`location_dest_id` se mandan explícitos al crear un move (ver `lib/sync/recepcion.ts`).
- **No hay base de test de Odoo.** Todo se prueba en producción, con un barco de QA y en tandas chicas.
- Stack: Next.js 16.3 (App Router), React 19.2, Drizzle + Neon (neon-http no tiene transacciones; se usa `db.batch`) y Vitest. Next 16 trae cambios: hay que leer `node_modules/next/dist/docs/` antes de escribir código (lo pide `AGENTS.md`).
- Deploy con `vercel --prod` desde local (no hay remote de GitHub). Después de deployar, verificar que el deploy activo sea posterior al commit.

## 5. Diseño

### 5.1 Dispositivos, navegación y estilo

- Es una sola app responsive. La recepción está pensada para la tablet en horizontal y la entrega para el móvil en vertical, pero las dos funcionan en ambos dispositivos.
- Pestañas: **Recepción · Entrega · Pendientes**, más **Admin** para el admin. En la tablet van arriba y en el móvil abajo. "Pendientes" muestra un número cuando hay algo que resolver.
- En la cabecera aparecen el almacén activo y el nombre del operario, con "Cerrar sesión". Si el operario tiene un solo almacén, no se puede cambiar.
- **[decisión de Claude]** El dispositivo recuerda el último almacén elegido.
- La app se puede agregar a la pantalla de inicio del móvil como si fuera una app (manifest web, sin service worker).
- Estilo aprobado en los bocetos: fondo claro y alto contraste; botones y filas grandes para el dedo; verde para la acción principal y para lo que entró bien; rojo para duplicados y errores; ámbar para lo que está en curso; tracking numbers en tipografía monoespaciada. Simple y sin adornos.
- **[decisión de Claude]** Solo tema claro.

### 5.2 Recepción (tablet + pistola)

Boceto: `mockups/2026-10-22-recepcion-tablet.html`.

**Inicio de Recepción**
- Buscador: "Buscar barco para empezar una recepción…".
- **Recepciones abiertas** del almacén, una por barco. Cada una muestra cuántos paquetes tiene, de qué couriers y hace cuánto está abierta. Al tocarla se abre.
- Botón **"Enviar las N a Odoo · M paquetes"**: manda todas las recepciones abiertas que tengan al menos un paquete válido. Cada recepción sigue siendo un picking de Odoo propio, igual que en la Fase 1.
- **Enviadas hoy**: cada recepción enviada con su estado. Puede estar enviándose, ✓ con la referencia de Odoo (por ejemplo `MB92/IN/00231`) o ⚠ con un problema, que lleva a Pendientes.
- **Escanear sin elegir barco:** si la pistola escanea estando en el inicio, la app guarda el código y pregunta "¿Para qué barco es?". Muestra el buscador de barcos y los couriers, con el último usado ya marcado. Al elegir el barco, el paquete entra en la recepción abierta de ese barco (o se crea una) y se abre esa recepción.

**Recepción de un barco**
- Cabecera con "volver", el nombre del barco en grande y el almacén.
- **Couriers.** El elegido queda marcado para los paquetes siguientes hasta que se cambie.
  - **[decisión de Claude]** Como botones aparecen los ~10 couriers más usados en ese almacén, y un botón **"Otro courier…"** abre un buscador con el resto. En Odoo hay 73 couriers (ver §6, punto 1), así que no entran todos como botones; el boceto mostraba 13.
  - **[decisión de Claude]** El "último usado" se recuerda por dispositivo, no por recepción, porque lo que deja un mismo courier suele ir a varios barcos.
- **Campo de escaneo**, siempre listo (ver "Reglas de la pistola").
- **Respuesta a cada escaneo:** una franja grande verde "✓ <código> · <courier> — agregado" o una roja "Duplicado: ya está en <referencia de Odoo> · no se envía". Además, un sonido distinto para cada caso, para no tener que mirar la pantalla.
- **Lista de paquetes**, con el último arriba, su courier y una ✕ para borrar un paquete escaneado por error. Los duplicados quedan en rojo y no se envían.
- Botones **"Dejar abierta"** (vuelve al inicio) y **"Enviar a Odoo · N paquetes"**.
- Desaparecen las "tandas" y los botones "Listo" y "Confirmar sesión".
- **[decisión de Claude]** Una recepción abierta se puede descartar; si tiene paquetes, se pide confirmación. Las recepciones vacías no se muestran y se limpian solas.

**Reglas de la pistola** (escribe el código y aprieta Enter)
- El campo de escaneo recupera el foco siempre: al abrir la pantalla, después de tocar un courier, borrar un paquete o cerrar un aviso.
- Ningún botón conserva el foco después de tocarlo, así el Enter de la pistola nunca lo activa.
- El campo de escaneo no abre el teclado en pantalla (`inputmode="none"`). El buscador de barcos sí lo abre.
- **[decisión de Claude]** Al lado del campo hay un botón **"Escribir a mano"** que, para un solo código, abre el teclado en pantalla. Sirve para una etiqueta que no se puede escanear y para usar la recepción desde un móvil sin pistola.
- Los escaneos rápidos no se pierden. Con cada Enter se toma el valor, se limpia el campo en el acto y la fila aparece al momento como "verificando…"; la respuesta del servidor llega después, en orden. Hoy el campo se limpia *después* de esa respuesta y borra lo que la pistola escribió mientras tanto (`app/(app)/recepcion/ScanClient.tsx:43-49`).
- Al código solo se le quitan los espacios del principio y del final; no se transforma de ninguna otra forma.

**Recepciones compartidas por almacén** **[decisión de Claude]**
- Como la tablet es compartida, una recepción abierta pertenece a un almacén y un barco, no a un operario. Cualquier operario con acceso a ese almacén la ve y puede agregarle paquetes. Hay como máximo una recepción abierta por almacén y barco, lo que además evita duplicados por doble toque.
- Se registra quién escaneó cada paquete. En Odoo, "Recibido por" (`ODOO_FIELD_RECIBIDO_POR`) lleva el nombre de quien escaneó; si fueron varios, los nombres separados por coma. Hoy, a mano, ponen el nombre de pila del operario (ver §2).

### 5.3 Entrega (móvil del operario)

Boceto: `mockups/2026-10-22-entrega-movil.html`. Son tres pasos:

1. **Elegir el barco.** Aparece la lista de barcos que tienen paquetes esperando entrega en el almacén, con cuántos son y desde cuándo esperan, y un buscador que filtra esa lista. Los datos se leen en vivo de Odoo, con una lectura puntual al abrir la pantalla. Debajo se ve "Entregadas hoy", con quién recibió cada una.
2. **Revisar los paquetes.** Se muestran **todas las líneas** de las entregas pendientes de ese barco en ese almacén, todas marcadas. Si Odoo tiene más de una entrega pendiente para ese barco, se juntan en una sola lista. Una línea sin tracking number se muestra con el courier y "sin número". Al tocar una línea se desmarca y queda "en depósito". Botón: "Siguiente: firma · N paquetes".
3. **Nombre y firma.** Arriba, un resumen (barco y cantidad de paquetes). Después, el campo "Nombre de quien recibe" (obligatorio) y un recuadro de firma que ocupa todo el espacio disponible, con "Borrar". "Confirmar entrega" se habilita cuando hay nombre y firma.

Al confirmar, la app guarda la entrega y la encola. Aparece "Entrega registrada, enviándose a Odoo" y se vuelve al inicio, donde la entrega figura en "Entregadas hoy". Si la conexión se corta al confirmar, no se pierde nada: el nombre, la firma y la selección quedan en pantalla para reintentar. Un doble toque no crea dos entregas.

**Paquetes recibidos pero no enviados a Odoo** **[decisión de Claude]**: si el barco tiene una recepción abierta en ese almacén, sus paquetes todavía no existen en Odoo y no aparecen en la entrega. Entonces:
- en el paso 1 el barco muestra un aviso ("+3 sin enviar a Odoo");
- en el paso 2 aparece una franja: "Hay 3 paquetes de este barco recibidos pero sin enviar a Odoo", con un botón "Enviar ahora". Después de enviarlos tardan alrededor de un minuto en aparecer, porque el cron de Odoo asigna el barco a la entrega una vez por minuto.

No se bloquea nada.

**En Odoo (lo hace el worker).** Para cada entrega pendiente involucrada:
- escribe la firma en `signature` (`is_signed` es calculado y de solo lectura en esta instancia: no se escribe);
- marca como hechas solo las líneas elegidas;
- valida y deja el resto en un **backorder**, que es como hoy se maneja lo que queda en depósito. Es lógica nativa de Odoo que hay que verificar con un barco de QA (ver §10): que el backorder conserve exactamente los tracking numbers no entregados y el barco;
- guarda el nombre del crew en "Recibido por" de la entrega (`ODOO_FIELD_RECIBIDO_POR`, hoy `x_studio_recibido_por_2`) y lo repite en la nota del chatter. Ese es el campo que se agrega al albarán impreso (ver §8). El nombre y la firma de esta entrega no deben terminar copiados en el backorder; hay que verificarlo con el barco de QA;
- deja una nota en el chatter.

Si de una entrega no se eligió ninguna línea, esa entrega no se toca.

Hoy (2026-10-22) las 71 entregas pendientes con barco solo tienen productos-courier. Igual, como la app muestra todas las líneas, el crew firma exactamente lo que ve.

**Firma:** el lienzo tiene que verse nítido en pantallas de alta densidad y adaptarse al ancho del móvil. Hoy mide 400×200 fijo y no se puede borrar (`app/(app)/entrega/SignaturePad.tsx`).

### 5.4 Pendientes

Es una sola página para todos, pensada para poder delegar:
- El operario ve los problemas de sus almacenes; el admin ve todos.
- Cada problema se explica en palabras simples: barco, almacén, quién y cuándo, qué paquetes, qué pasó y qué hacer. El error técnico queda escondido en "Ver detalle".
- Hay tres tipos:
  - **No se pudo enviar a Odoo** → botón "Reintentar". Si el error es de configuración (por ejemplo, un campo faltante), dice "Lo tiene que arreglar el admin".
  - **Envío trabado** (lleva más de cierto tiempo enviándose) → "Reintentar". **[decisión de Claude]**
  - **Paquete que no entró por duplicado** (se detectó recién al enviar) → explica dónde estaba ya en Odoo, con el botón "Marcar como revisado".
- Lo resuelto o revisado deja de aparecer; hoy los duplicados quedan para siempre. Se registra quién lo resolvió.

### 5.5 Admin

Con la misma estética:
- **Almacenes y couriers se leen de Odoo** y desaparece la pantalla "Mapeos" (ver §6, punto 1). **[decisión de Claude]** El admin no carga IDs a mano.
- **Operarios:** alta, activar y desactivar, y asignar almacenes (ya existe). La lista muestra los almacenes de cada operario.
- **Datos de Odoo:** el botón "Refrescar" (barcos, almacenes y couriers) muestra feedback y cuándo fue el último refresco.

## 6. Arreglos en la webapp (lo que encontró la revisión)

Ordenados por importancia, con referencia al código actual.

1. **Couriers y almacenes mal mapeados o faltantes.**
   - **Couriers mal mapeados.** En la tabla `couriers`, "Amazon" apunta al producto 11, que en Odoo es **DHL**. "DHL" apunta al 15, que es **CTT**. "UPS" apunta al 21, "UPS (incorrecto)", que además no tiene seguimiento por número de serie (el correcto es el 125). Un paquete escaneado como Amazon entraría en Odoo como DHL.
   - **Faltan couriers.** La app conoce 13 couriers y Odoo usa 73: todos los productos con seguimiento por número de serie (Chronopost, Nacex, DPD, TNT, InPost…). En las pruebas, un paquete de Chronopost se cargó como "CTT Express" porque no estaba en la lista.
   - **Almacenes.** "MLC" no existe en Odoo, y faltan TGN (Port Tarraco) y DECK (código `COPIA`). Además, cada almacén tiene un tipo de operación de recepción y otro de entrega, pero la app guarda uno solo.
   - **[decisión de Claude]** Se leen de Odoo en el mismo refresco diario de los barcos (y con el botón del admin):
     - **almacenes** = `stock.warehouse` (código, nombre, `in_type_id` y `out_type_id`);
     - **couriers** = productos activos con `tracking = 'serial'`.

     Así se eliminan la carga manual de IDs y la pantalla "Mapeos". La migración tiene que conservar las asignaciones operario-almacén que ya existen (MB92, MPV).
2. **La entrega no encontraría nada pendiente.** `getPendingOutgoing` (`lib/odoo/pickings.ts:95-107`) filtra por el `picking_type_id` del almacén, que es el de *recepción* (MB92 = 1), y a la vez por `picking_type_code = 'outgoing'`. Las dos condiciones nunca se cumplen juntas. Tiene que usar el `out_type_id` del almacén (MB92 = 2), que viene del punto 1.
3. **Un error de sincronización traba la cola de todos.** `/api/qstash/sync-session` responde 500 ante cualquier error (`app/api/qstash/sync-session/route.ts:37-45`). QStash reintenta con backoff y, con `parallelism: 1`, nada más avanza hasta que alguien purga la cola a mano en Upstash. Ya pasó en septiembre. Lo que se pide:
   - Los errores que no se arreglan solos (configuración, validaciones de Odoo) no se reintentan: la sesión queda en `error` y aparece en Pendientes.
   - Los pasajeros (red, timeout, 5xx, 429) se reintentan pocas veces y con espera corta.
   - El mecanismo lo elige el builder. Por ejemplo: fijar `retries` al encolar y responder 2xx después de marcar `error`, o usar el error no reintentable de QStash si está disponible.
4. **Odoo recibe el UUID del operario.** El chatter y "Recibido por" (`lib/sync/recepcion.ts:148,153`) y la nota de entrega (`lib/sync/entrega.ts:38`) usan `operarioId`. En Odoo hoy se ve, por ejemplo, "Recibido por: 6785d27a-6b22-…". Tienen que usar el nombre.
5. **Al escanear, el aviso de duplicado solo conoce lo que entró por la webapp.** `tracking_activos_cache` solo se llena al sincronizar, y hoy tiene 4 filas. Hace falta una carga nocturna desde Odoo, por la cola y paginada, de los tracking numbers de pickings no cancelados, con la referencia del picking para poder decir "ya está en MB92/IN/00198". Tiene que reflejar las cancelaciones: lo que ya no está en Odoo deja de contar. El chequeo en vivo al enviar se mantiene como red de seguridad final.
6. **No se puede dejar un paquete suelto en depósito.** Hoy solo se eligen entregas enteras, y el cron de Odoo junta todo lo pendiente de un barco y almacén en una sola entrega, así que en la práctica no había cómo. Se resuelve con lo descrito en §5.3.
7. **Doble toque y doble envío.** Elegir dos veces el barco crea dos sesiones; pasó en las pruebas, con 0,6 s de diferencia. Se resuelve con tres cosas: una recepción abierta por almacén y barco (índice único), botones deshabilitados mientras procesan, e idempotencia al confirmar la entrega.
8. **Se pierden escaneos** si la pistola dispara mientras el servidor responde (ver §5.2).
9. **El buscador de barcos** (`lib/cache/barcos.ts:28-32`) no tiene límite ni orden, muestra barcos que ya no existen en Odoo (el refresco nunca borra nada) y no escapa `%` ni `_`. Además, cada tecla dispara una búsqueda y las respuestas pueden llegar desordenadas. Hay que limitar y ordenar los resultados, marcar como inactivos los barcos que desaparecen al refrescar y descartar en el cliente las respuestas viejas. Si dos barcos activos se llaman igual, se muestra algo que los distinga.
10. **La interfaz no maneja errores.** Las acciones lanzan excepciones que terminan en la pantalla de error de Next. Las esperables (sin acceso al almacén, sesión vencida, Odoo que no responde) tienen que mostrarse como un mensaje.
11. **`audit_log` nunca se escribe**, aunque la Fase 1 lo pedía. **[decisión de Claude]** Registrar lo mínimo: envío de recepción, confirmación de entrega, resultado de cada sincronización, reintentos, "Marcar como revisado" y cambios de admin.
12. **Pendientes muestra UUIDs y errores crudos**, y un duplicado nunca se puede descartar (ver §5.4).

Lo que **no** es un problema: las recepciones que manda la webapp generan su entrega en Odoo igual que las cargadas a mano (ver Anexo A).

## 7. Qué queda a criterio del builder

- La estructura de componentes, el CSS (módulos o global con variables) y la tipografía. Hoy se carga Geist, pero el body usa Arial.
- Los cambios de esquema y la migración. Columnas nuevas previsibles: almacenes y couriers con sus IDs de Odoo, `activo` en barcos, operario por paquete, referencia del picking de Odoo, nombre de quien recibe, líneas elegidas de la entrega, y quién revisó y cuándo.
- Cómo calcular los "couriers más usados" de cada almacén.
- Cómo cachear la lista de entregas pendientes sin pasar de 1 request por segundo.
- Textos exactos, sonidos y tiempos (por ejemplo, cuándo un envío cuenta como trabado).
- Cuántos reintentos y cuánta espera para los errores pasajeros.
- Cómo mostrar "abierta hace X" y cuándo resaltar una recepción vieja.
- Tests: la suite de Vitest tiene que seguir en verde y la lógica nueva tiene que quedar cubierta.

## 8. Tareas del usuario antes de usarla en serio (no son código)

- **Limpiar los barcos duplicados en Odoo** (archivar los que sobran). Hay 4 "H3" (ids 935, 942, 943 y 944) y tres versiones de Mayan Queen: "MAYAN QUEEN", "MAYANQUEEN" y "MAYANQUEENIV" (951, 673 y 674).
- **Limpiar couriers duplicados en Odoo:** hay dos productos "DHL" (ids 11 y 104), y los dos aparecerían en la app.
- **Agregar "Recibido por" al albarán con Studio**, debajo de la firma (`stock.report_delivery_document`), para que se imprima el nombre del crew. Es un cambio chico dentro de Odoo, que hace el usuario o Vanesa. El usuario decide si cuenta contra el presupuesto de código custom.
- **Configurar la pistola** con el mismo idioma de teclado que la tablet (o ajustar en la tablet la distribución del teclado físico) y con Enter al final. En las pruebas, un código PAACK quedó con "/" donde iba "-".
- **Configurar la tablet para que muestre el teclado en pantalla con la pistola Bluetooth conectada.** Hace falta para el buscador de barcos y para "Escribir a mano".
  - En iPad: con un teclado Bluetooth conectado, el teclado en pantalla se esconde. Se muestra con el botón de teclado de la barra que queda abajo; algunas pistolas también tienen un modo para alternarlo.
  - En Android: activar "Mostrar teclado virtual" en los ajustes de teclado físico.
- **Limpiar las pruebas.**
  - Las 6 sesiones `en_curso` de Neon son pruebas (lo confirmó el usuario) y se descartan antes de crear el índice único.
  - En Odoo, las entregas de las 2 recepciones de prueba (`MB92/OUT/00403` y `MB92/OUT/00482`) ya están canceladas.
  - Pero en el stock de MB92 siguen 4 paquetes de prueba: 3 BPOST con códigos inventados (`hdfuhasdfa`, `asdfasdf`, `asdfsd7fsd`) y `XW297134737JF` como CTT Express. Ese paquete en realidad era Chronopost y ya se entregó. Conviene sacarlos con un ajuste de inventario.
- **Opcional:** en Odoo, el almacén DECK tiene código `COPIA`, y la app va a mostrar ese código. Si se prefiere "DCK", hay que cambiarlo en Odoo.

## 9. Preguntas respondidas por el usuario

1. **¿El nombre del crew tiene que salir impreso en el albarán?** Sí. Hoy el albarán imprime la firma y, debajo, el nombre del contacto de la entrega (`partner_id`), que en estas entregas está vacío. Por eso la webapp guarda el nombre en "Recibido por" de la entrega (§5.3), y ese campo se agrega al albarán con Studio (§8).
2. **¿Cómo se conecta la pistola?** Por Bluetooth. No se precisó si la tablet es iPad o Android, así que §8 trae los pasos para los dos.

## 10. Verificación

- **En la tablet real con la pistola:**
  - escanear 10 paquetes seguidos y rápido, sin que se pierda ninguno;
  - comprobar que el Enter nunca activa un botón;
  - comprobar que el teclado en pantalla no aparece en el campo de escaneo pero sí en el buscador de barcos y con "Escribir a mano", con la pistola conectada.
- **En un móvil:** hacer una entrega completa y una parcial con el barco de QA. En Odoo, verificar:
  - la firma y el nombre de quien recibe;
  - que el backorder tenga exactamente los paquetes que quedaron y el barco, y que no herede el nombre ni la firma;
  - el chatter;
  - que el albarán impreso muestre la firma y, debajo, el nombre de quien recibe.
- **Cola:** forzar un error de configuración y comprobar que no traba la cola y que aparece en Pendientes.
- **Odoo:** verificar que "Recibido por" muestra el nombre, y que un paquete escaneado con cada uno de los couriers más usados entra con el producto correcto.

---

## Anexo A — Datos de Odoo verificados (lecturas del 2026-10-22)

**Almacenes** (`stock.warehouse` → tipos de operación de recepción y de entrega):

| Código | Nombre | Recepción | Entrega |
|---|---|---|---|
| MB92 | MB92 - Barcelona | 1 | 2 |
| MPV | Marina Port Vell - Barcelona | 9 | 10 |
| VLN | Pendennis - Vilanova | 17 | 18 |
| TGN | Port Tarraco - Tarragona | 25 | 26 |
| MLG | IGY - Malaga | 33 | 34 |
| MLR | Mallorca - Baleares | 41 | 42 |
| IBZ | Ibiza - Baleares | 49 | 50 |
| COPIA | DECK - MB92 Barcelona | 57 | 58 |

**Cómo se genera la entrega.** Cada courier tiene asignadas las rutas "Recepcion y Entrega de Paquetes - <almacén>". Cada ruta tiene una regla push "Entrega al cliente" que va de `<almacén>/Stock` a `Customers`, con el tipo de entrega del almacén. Al validar la recepción, Odoo crea el movimiento de entrega encadenado. Después, el cron le asigna el barco y lo junta con lo que ya estaba pendiente.

Las recepciones de la webapp lo generan igual que las manuales: `MB92/IN/00200` generó el movimiento de entrega en `MB92/OUT/00403` y `MB92/IN/00490` en `MB92/OUT/00482`. Las dos entregas se cancelaron después.

**Campos de `stock.picking`:**
- `x_studio_recibido_por_2` ("Recibido por", char) es el que está en el formulario, para todas las operaciones (recepciones y entregas).
- `x_studio_recibido_por` y `x_studio_recibido_por_1` existen pero no están en el formulario.
- `signature` es binario y se puede escribir.
- `is_signed` es calculado y de solo lectura.
- `partner_id` está oculto en el formulario.

**Albarán** (`stock.report_delivery_document`, sin personalizar): imprime la firma y, debajo, `o.partner_id.name` si existe. No imprime "Recibido por".

**Couriers:**
- 73 productos activos con `tracking = 'serial'`, todos transportistas o remitentes.
- "UPS (incorrecto)" (id 21) tiene `tracking = 'none'`.
- Los productos no tienen categoría, así que no sirven para filtrar.
