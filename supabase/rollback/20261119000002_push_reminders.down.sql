-- =====================================================================
-- Rollback cho migration 20261119000002_push_reminders
-- Chạy SAU KHI đã gỡ lịch chạy: supabase/cron/viec_cua_toi_reminders.down.sql
-- Xoá dữ liệu thiết bị và nhật ký nhắc việc. Sao lưu trước khi chạy:
--   pg_dump "$DATABASE_URL" --schema=viec_cua_toi > backup_viec_cua_toi.sql
-- Chỉ đụng tới schema viec_cua_toi.
-- =====================================================================

BEGIN;

DROP FUNCTION IF EXISTS viec_cua_toi.claim_due_reminders(INTEGER, TIME, INTEGER, INTEGER);
DROP TABLE IF EXISTS viec_cua_toi.reminder_log;
DROP TABLE IF EXISTS viec_cua_toi.push_subscriptions;
DROP FUNCTION IF EXISTS viec_cua_toi.tg_reminder_log_touch();
DROP FUNCTION IF EXISTS viec_cua_toi.tg_push_subscriptions_check_tz();
DROP FUNCTION IF EXISTS viec_cua_toi.tg_set_audit();
DROP INDEX IF EXISTS viec_cua_toi.ix_tasks_due_open;

COMMIT;
