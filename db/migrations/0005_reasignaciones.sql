ALTER TYPE "public"."tipo_sesion" ADD VALUE 'reasignacion';--> statement-breakpoint
ALTER TABLE "sesiones_escaneo" ADD COLUMN "barco_destino_odoo_id" integer;