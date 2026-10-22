-- Recepciones de prueba que quedaron en_curso. Confirmado por el usuario el 2026-10-22.
DELETE FROM sesion_items WHERE courier_batch_id IN (
  SELECT b.id FROM sesion_courier_batches b JOIN sesiones_escaneo s ON s.id = b.sesion_id WHERE s.estado = 'en_curso');
DELETE FROM sesion_courier_batches WHERE sesion_id IN (SELECT id FROM sesiones_escaneo WHERE estado = 'en_curso');
DELETE FROM sesiones_escaneo WHERE estado = 'en_curso';
