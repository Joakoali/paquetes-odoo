CREATE TYPE "public"."error_tipo" AS ENUM('configuracion', 'odoo', 'conexion');--> statement-breakpoint
CREATE TABLE "courier_uso" (
	"almacen_id" integer NOT NULL,
	"courier_id" integer NOT NULL,
	"usos" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "courier_uso_almacen_id_courier_id_pk" PRIMARY KEY("almacen_id","courier_id")
);
--> statement-breakpoint
ALTER TABLE "couriers" DROP CONSTRAINT "couriers_nombre_unique";--> statement-breakpoint
ALTER TABLE "couriers" ALTER COLUMN "nombre" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "almacenes" ADD COLUMN "odoo_out_type_id" integer;--> statement-breakpoint
ALTER TABLE "almacenes" ADD COLUMN "odoo_warehouse_id" integer;--> statement-breakpoint
ALTER TABLE "almacenes" ADD COLUMN "activo" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "barcos_cache" ADD COLUMN "activo" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "couriers" ADD COLUMN "activo" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sesion_items" ADD COLUMN "operario_id" uuid;--> statement-breakpoint
ALTER TABLE "sesion_items" ADD COLUMN "duplicado_ref" text;--> statement-breakpoint
ALTER TABLE "sesion_items" ADD COLUMN "duplicado_al_enviar" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sesiones_escaneo" ADD COLUMN "odoo_picking_ref" text;--> statement-breakpoint
ALTER TABLE "sesiones_escaneo" ADD COLUMN "receptor_nombre" text;--> statement-breakpoint
ALTER TABLE "sesiones_escaneo" ADD COLUMN "odoo_move_line_ids" jsonb;--> statement-breakpoint
ALTER TABLE "sesiones_escaneo" ADD COLUMN "ultimo_error_tipo" "error_tipo";--> statement-breakpoint
ALTER TABLE "sesiones_escaneo" ADD COLUMN "revisado_at" timestamp;--> statement-breakpoint
ALTER TABLE "sesiones_escaneo" ADD COLUMN "revisado_por" uuid;--> statement-breakpoint
ALTER TABLE "tracking_activos_cache" ADD COLUMN "odoo_picking_ref" text;--> statement-breakpoint
ALTER TABLE "courier_uso" ADD CONSTRAINT "courier_uso_almacen_id_almacenes_id_fk" FOREIGN KEY ("almacen_id") REFERENCES "public"."almacenes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_uso" ADD CONSTRAINT "courier_uso_courier_id_couriers_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."couriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesion_items" ADD CONSTRAINT "sesion_items_operario_id_operarios_id_fk" FOREIGN KEY ("operario_id") REFERENCES "public"."operarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sesiones_escaneo" ADD CONSTRAINT "sesiones_escaneo_revisado_por_operarios_id_fk" FOREIGN KEY ("revisado_por") REFERENCES "public"."operarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sesiones_recepcion_abierta_unica" ON "sesiones_escaneo" USING btree ("almacen_id","barco_odoo_id") WHERE tipo = 'recepcion' and estado = 'en_curso';--> statement-breakpoint
ALTER TABLE "almacenes" ADD CONSTRAINT "almacenes_odoo_warehouse_id_unique" UNIQUE("odoo_warehouse_id");--> statement-breakpoint
ALTER TABLE "couriers" ADD CONSTRAINT "couriers_odoo_product_id_unique" UNIQUE("odoo_product_id");--> statement-breakpoint
ALTER TABLE "sesion_courier_batches" ADD CONSTRAINT "sesion_courier_batches_sesion_id_courier_id_unique" UNIQUE("sesion_id","courier_id");