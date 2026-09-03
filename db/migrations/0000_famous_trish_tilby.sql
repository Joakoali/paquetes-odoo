CREATE TYPE "public"."estado_item" AS ENUM('ok', 'duplicado', 'sincronizado', 'error');--> statement-breakpoint
CREATE TYPE "public"."estado_sesion" AS ENUM('en_curso', 'confirmada_pendiente_sync', 'sincronizada', 'error');--> statement-breakpoint
CREATE TYPE "public"."rol" AS ENUM('operario', 'admin');--> statement-breakpoint
CREATE TYPE "public"."tipo_sesion" AS ENUM('recepcion', 'entrega');--> statement-breakpoint
CREATE TABLE "almacenes" (
	"id" serial PRIMARY KEY NOT NULL,
	"prefijo" varchar(16) NOT NULL,
	"nombre" text NOT NULL,
	"odoo_picking_type_id" integer,
	CONSTRAINT "almacenes_prefijo_unique" UNIQUE("prefijo")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operario_id" uuid,
	"accion" text NOT NULL,
	"detalle" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "barcos_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"odoo_id" integer NOT NULL,
	"nombre" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "barcos_cache_odoo_id_unique" UNIQUE("odoo_id")
);
--> statement-breakpoint
CREATE TABLE "couriers" (
	"id" serial PRIMARY KEY NOT NULL,
	"nombre" varchar(64) NOT NULL,
	"odoo_product_id" integer,
	CONSTRAINT "couriers_nombre_unique" UNIQUE("nombre")
);
--> statement-breakpoint
CREATE TABLE "operario_almacenes" (
	"operario_id" uuid NOT NULL,
	"almacen_id" integer NOT NULL,
	CONSTRAINT "operario_almacenes_operario_id_almacen_id_pk" PRIMARY KEY("operario_id","almacen_id")
);
--> statement-breakpoint
CREATE TABLE "operarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"login" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"rol" "rol" DEFAULT 'operario' NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "operarios_login_unique" UNIQUE("login")
);
--> statement-breakpoint
CREATE TABLE "sesion_courier_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sesion_id" uuid NOT NULL,
	"courier_id" integer NOT NULL,
	"odoo_move_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sesion_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"courier_batch_id" uuid NOT NULL,
	"tracking_number" text NOT NULL,
	"estado" "estado_item" DEFAULT 'ok' NOT NULL,
	"odoo_lot_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sesion_items_courier_batch_id_tracking_number_unique" UNIQUE("courier_batch_id","tracking_number")
);
--> statement-breakpoint
CREATE TABLE "sesiones_auth" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operario_id" uuid NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sesiones_escaneo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operario_id" uuid NOT NULL,
	"almacen_id" integer NOT NULL,
	"barco_odoo_id" integer NOT NULL,
	"tipo" "tipo_sesion" NOT NULL,
	"estado" "estado_sesion" DEFAULT 'en_curso' NOT NULL,
	"odoo_picking_id" integer,
	"odoo_picking_ids" jsonb,
	"firma_data" text,
	"intentos" integer DEFAULT 0 NOT NULL,
	"ultimo_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"confirmed_at" timestamp,
	"synced_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "tracking_activos_cache" (
	"tracking_number" text PRIMARY KEY NOT NULL,
	"odoo_picking_id" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_operario_id_operarios_id_fk" FOREIGN KEY ("operario_id") REFERENCES "public"."operarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operario_almacenes" ADD CONSTRAINT "operario_almacenes_operario_id_operarios_id_fk" FOREIGN KEY ("operario_id") REFERENCES "public"."operarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operario_almacenes" ADD CONSTRAINT "operario_almacenes_almacen_id_almacenes_id_fk" FOREIGN KEY ("almacen_id") REFERENCES "public"."almacenes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesion_courier_batches" ADD CONSTRAINT "sesion_courier_batches_sesion_id_sesiones_escaneo_id_fk" FOREIGN KEY ("sesion_id") REFERENCES "public"."sesiones_escaneo"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesion_courier_batches" ADD CONSTRAINT "sesion_courier_batches_courier_id_couriers_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."couriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesion_items" ADD CONSTRAINT "sesion_items_courier_batch_id_sesion_courier_batches_id_fk" FOREIGN KEY ("courier_batch_id") REFERENCES "public"."sesion_courier_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones_auth" ADD CONSTRAINT "sesiones_auth_operario_id_operarios_id_fk" FOREIGN KEY ("operario_id") REFERENCES "public"."operarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones_escaneo" ADD CONSTRAINT "sesiones_escaneo_operario_id_operarios_id_fk" FOREIGN KEY ("operario_id") REFERENCES "public"."operarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones_escaneo" ADD CONSTRAINT "sesiones_escaneo_almacen_id_almacenes_id_fk" FOREIGN KEY ("almacen_id") REFERENCES "public"."almacenes"("id") ON DELETE no action ON UPDATE no action;