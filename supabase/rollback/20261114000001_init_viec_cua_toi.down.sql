-- =====================================================================
-- Rollback cho migration 20261114000001_init_viec_cua_toi
--
-- CẢNH BÁO: script này xoá toàn bộ dữ liệu của app Việc của tôi.
-- Chỉ chạy khi chắc chắn, và PHẢI sao lưu trước:
--   pg_dump "$DATABASE_URL" --schema=viec_cua_toi > backup_viec_cua_toi.sql
-- Script chỉ đụng tới schema viec_cua_toi, không ảnh hưởng project khác.
-- =====================================================================

BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication_tables
               WHERE pubname = 'supabase_realtime'
                 AND schemaname = 'viec_cua_toi' AND tablename = 'tasks') THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE viec_cua_toi.tasks';
    END IF;
END;
$$;

DROP SCHEMA IF EXISTS viec_cua_toi CASCADE;

COMMIT;
