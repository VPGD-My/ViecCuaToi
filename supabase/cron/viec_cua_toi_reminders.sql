-- =====================================================================
-- Lịch chạy bộ nhắc việc: gọi Edge Function viec-cua-toi-reminders mỗi 5 phút
--
-- PHẦN NÀY ĐỤNG TỚI CÀI ĐẶT DÙNG CHUNG CỦA DATABASE. Đọc docs/LUU-Y-DATABASE.md trước.
--   * pg_cron, pg_net và Vault dùng chung cho cả database.
--   * Tên job và tên secret đều có tiền tố viec_cua_toi_ để không trùng project khác.
--   * Script chỉ THÊM job và secret, không sửa hay xoá job/secret có sẵn.
--
-- Chuẩn bị:
--   1. Dashboard > Database > Extensions: kiểm tra pg_cron và pg_net đã bật chưa.
--      Nếu chưa, báo người phụ trách project kia trước khi bật (bật chỉ thêm, không đổi gì có sẵn).
--   2. Thay 2 giá trị <...> bên dưới. Chuỗi bí mật phải trùng VIEC_CUA_TOI_CRON_SECRET
--      đã đặt cho Edge Function.
--   3. Chạy file này trong SQL Editor. Gỡ: viec_cua_toi_reminders.down.sql
-- =====================================================================

-- Không ghi đè job đang có: dừng nếu tên đã tồn tại
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'viec_cua_toi_reminders') THEN
        RAISE EXCEPTION 'Job viec_cua_toi_reminders đã tồn tại. Gỡ bằng file .down.sql trước nếu muốn tạo lại.';
    END IF;
END;
$$;

SELECT vault.create_secret(
    'https://zjxeufyiuuiqftpllotz.supabase.co/functions/v1/viec-cua-toi-reminders',
    'viec_cua_toi_reminder_url',
    'URL Edge Function nhắc việc của app Việc của tôi'
);
SELECT vault.create_secret(
    'ec27c2a74e3e4456b6312bd0f2cbd0cb0d26c1886ece41ad8a51f092a00668ef',
    'viec_cua_toi_cron_secret',
    'Chuỗi bí mật để cron gọi Edge Function nhắc việc'
);

SELECT cron.schedule(
    'viec_cua_toi_reminders',
    '*/5 * * * *',
    $job$
    SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'viec_cua_toi_reminder_url'),
        headers := jsonb_build_object(
                       'Content-Type', 'application/json',
                       'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'viec_cua_toi_cron_secret')
                   ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 25000
    );
    $job$
);

-- Kiểm tra
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'viec_cua_toi_reminders';
