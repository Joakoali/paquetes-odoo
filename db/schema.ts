import { sql } from 'drizzle-orm'
import {
  pgTable, uuid, text, varchar, boolean, integer, timestamp,
  pgEnum, jsonb, serial, primaryKey, unique, uniqueIndex,
} from 'drizzle-orm/pg-core'

export const rolEnum = pgEnum('rol', ['operario', 'admin'])
export const tipoSesionEnum = pgEnum('tipo_sesion', ['recepcion', 'entrega'])
export const estadoSesionEnum = pgEnum('estado_sesion', [
  'en_curso', 'confirmada_pendiente_sync', 'sincronizada', 'error',
])
export const estadoItemEnum = pgEnum('estado_item', [
  'ok', 'duplicado', 'sincronizado', 'error',
])
export const errorTipoEnum = pgEnum('error_tipo', ['configuracion', 'odoo', 'conexion'])

export const operarios = pgTable('operarios', {
  id: uuid('id').primaryKey().defaultRandom(),
  nombre: text('nombre').notNull(),
  login: varchar('login', { length: 64 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rol: rolEnum('rol').notNull().default('operario'),
  activo: boolean('activo').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const sesionesAuth = pgTable('sesiones_auth', {
  id: uuid('id').primaryKey().defaultRandom(),
  operarioId: uuid('operario_id').notNull().references(() => operarios.id),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const almacenes = pgTable('almacenes', {
  id: serial('id').primaryKey(),
  prefijo: varchar('prefijo', { length: 16 }).notNull().unique(),
  nombre: text('nombre').notNull(),
  // Same column as before (`odoo_picking_type_id`): only the TS property is renamed.
  odooInTypeId: integer('odoo_picking_type_id'),
  odooOutTypeId: integer('odoo_out_type_id'),
  odooWarehouseId: integer('odoo_warehouse_id').unique(),
  activo: boolean('activo').notNull().default(true),
})

export const operarioAlmacenes = pgTable('operario_almacenes', {
  operarioId: uuid('operario_id').notNull().references(() => operarios.id),
  almacenId: integer('almacen_id').notNull().references(() => almacenes.id),
}, (t) => ({
  pk: primaryKey({ columns: [t.operarioId, t.almacenId] }),
}))

export const barcosCache = pgTable('barcos_cache', {
  id: serial('id').primaryKey(),
  odooId: integer('odoo_id').notNull().unique(),
  nombre: text('nombre').notNull(),
  activo: boolean('activo').notNull().default(true),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const couriers = pgTable('couriers', {
  id: serial('id').primaryKey(),
  nombre: text('nombre').notNull(),
  // Still nullable so db/seed.ts (which only sets `nombre`) keeps working; the
  // daily Odoo refresh always fills it.
  odooProductId: integer('odoo_product_id').unique(),
  activo: boolean('activo').notNull().default(true),
})

export const courierUso = pgTable('courier_uso', {
  almacenId: integer('almacen_id').notNull().references(() => almacenes.id),
  courierId: integer('courier_id').notNull().references(() => couriers.id),
  usos: integer('usos').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.almacenId, t.courierId] }),
}))

export const sesionesEscaneo = pgTable('sesiones_escaneo', {
  id: uuid('id').primaryKey().defaultRandom(),
  operarioId: uuid('operario_id').notNull().references(() => operarios.id),
  almacenId: integer('almacen_id').notNull().references(() => almacenes.id),
  barcoOdooId: integer('barco_odoo_id').notNull(),
  tipo: tipoSesionEnum('tipo').notNull(),
  estado: estadoSesionEnum('estado').notNull().default('en_curso'),
  odooPickingId: integer('odoo_picking_id'),
  odooPickingIds: jsonb('odoo_picking_ids').$type<number[]>(),
  odooPickingRef: text('odoo_picking_ref'),
  receptorNombre: text('receptor_nombre'),
  odooMoveLineIds: jsonb('odoo_move_line_ids').$type<number[]>(),
  firmaData: text('firma_data'),
  intentos: integer('intentos').notNull().default(0),
  ultimoError: text('ultimo_error'),
  ultimoErrorTipo: errorTipoEnum('ultimo_error_tipo'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at'),
  syncedAt: timestamp('synced_at'),
  revisadoAt: timestamp('revisado_at'),
  revisadoPor: uuid('revisado_por').references(() => operarios.id),
}, (t) => ({
  // At most one open recepción per (almacén, barco): the second operario to open
  // the same barco joins the existing one. Raw SQL on purpose: unqualified column
  // names, as Postgres expects in an index predicate.
  recepcionAbiertaUnica: uniqueIndex('sesiones_recepcion_abierta_unica')
    .on(t.almacenId, t.barcoOdooId)
    .where(sql`tipo = 'recepcion' and estado = 'en_curso'`),
}))

export const sesionCourierBatches = pgTable('sesion_courier_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  sesionId: uuid('sesion_id').notNull().references(() => sesionesEscaneo.id),
  courierId: integer('courier_id').notNull().references(() => couriers.id),
  odooMoveId: integer('odoo_move_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  uniqSesionCourier: unique().on(t.sesionId, t.courierId),
}))

export const sesionItems = pgTable('sesion_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  courierBatchId: uuid('courier_batch_id').notNull().references(() => sesionCourierBatches.id),
  trackingNumber: text('tracking_number').notNull(),
  estado: estadoItemEnum('estado').notNull().default('ok'),
  odooLotId: integer('odoo_lot_id'),
  operarioId: uuid('operario_id').references(() => operarios.id),
  duplicadoRef: text('duplicado_ref'),
  duplicadoAlEnviar: boolean('duplicado_al_enviar').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  uniqTracking: unique().on(t.courierBatchId, t.trackingNumber),
}))

export const trackingActivosCache = pgTable('tracking_activos_cache', {
  trackingNumber: text('tracking_number').primaryKey(),
  odooPickingId: integer('odoo_picking_id').notNull(),
  odooPickingRef: text('odoo_picking_ref'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  operarioId: uuid('operario_id').references(() => operarios.id),
  accion: text('accion').notNull(),
  detalle: jsonb('detalle'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export type Operario = typeof operarios.$inferSelect
export type Almacen = typeof almacenes.$inferSelect
export type Courier = typeof couriers.$inferSelect
export type SesionEscaneo = typeof sesionesEscaneo.$inferSelect
export type SesionCourierBatch = typeof sesionCourierBatches.$inferSelect
export type SesionItem = typeof sesionItems.$inferSelect
export type BarcoCache = typeof barcosCache.$inferSelect
export type ErrorTipo = (typeof errorTipoEnum.enumValues)[number]
