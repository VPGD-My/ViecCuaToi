-- Gỡ lịch chạy bộ nhắc việc. Chỉ đụng job và secret có tiền tố viec_cua_toi_.
SELECT cron.unschedule('viec_cua_toi_reminders')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'viec_cua_toi_reminders');

-- Secret trong Vault: bảng cấu hình hệ thống, không có xoá mềm.
-- Xem lại đúng 2 dòng trước khi xoá:
SELECT id, name FROM vault.secrets WHERE name IN ('viec_cua_toi_reminder_url', 'viec_cua_toi_cron_secret');
DELETE FROM vault.secrets WHERE name IN ('viec_cua_toi_reminder_url', 'viec_cua_toi_cron_secret');
