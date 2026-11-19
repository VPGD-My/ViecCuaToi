# Lưu ý khi dùng chung database Supabase

Database Supabase của app **Việc của tôi** đang dùng chung với một project khác. Mọi thay đổi phải tuân theo bảng dưới đây để không ảnh hưởng project kia.

## Phạm vi của app

| Hạng mục | Thuộc app Việc của tôi | Không được đụng tới |
|---|---|---|
| Schema | `viec_cua_toi` | `public`, `auth`, `storage`, schema của project khác |
| Bảng | `viec_cua_toi.tasks`, `viec_cua_toi.audit_log`, `viec_cua_toi.push_subscriptions`, `viec_cua_toi.reminder_log` | Mọi bảng ngoài schema `viec_cua_toi` |
| Hàm, trigger | `viec_cua_toi.tg_*`, `viec_cua_toi.claim_due_reminders` | Hàm, trigger ngoài schema `viec_cua_toi` |
| Edge Function | `viec-cua-toi-reminders` | Function của project kia. Không deploy đè function trùng tên |
| Secret của Edge Function | Chỉ các biến bắt đầu bằng `VIEC_CUA_TOI_` | Biến của project kia (secret dùng chung cho mọi function trong project) |
| Lịch chạy (pg_cron) | Job `viec_cua_toi_reminders` | Job khác trong `cron.job` |
| Vault | Secret `viec_cua_toi_reminder_url`, `viec_cua_toi_cron_secret` | Secret khác trong Vault |
| Realtime | Chỉ thêm `viec_cua_toi.tasks` vào publication `supabase_realtime` | Không xoá hay đổi bảng khác trong publication |
| Khoá phiên đăng nhập trên trình duyệt | `viec-cua-toi-auth` | Khoá mặc định `sb-<project>-auth-token` của app kia |

## Cài đặt dùng chung, cần cẩn thận

| Cài đặt (Supabase Dashboard) | Ảnh hưởng | Cách làm đúng |
|---|---|---|
| Project Settings > Data API > Exposed schemas | Danh sách schema mà API cho phép truy cập | **Thêm** `viec_cua_toi` vào danh sách, **giữ nguyên** các schema đang có (thường là `public`, `graphql_public`) |
| Authentication > URL Configuration > Site URL | Link mặc định trong email của cả hai app | **Không đổi**. App này luôn gửi `redirectTo` riêng |
| Authentication > URL Configuration > Redirect URLs | Danh sách link được phép quay về sau khi bấm email | **Thêm** link app này (ví dụ `https://<user>.github.io/viec-cua-toi/**`), không xoá link cũ |
| Authentication > Providers > Email (bật đăng ký, xác nhận email) | Áp dụng cho cả hai app | Không bật/tắt nếu chưa hỏi người phụ trách project kia |
| Authentication > Email Templates | Nội dung email gửi cho người dùng cả hai app | Không sửa. Nếu cần sửa, viết nội dung chung cho cả hai app |
| Bảng `auth.users` | Tài khoản dùng chung | Người dùng của project kia đăng nhập được app này, nhưng chỉ thấy danh sách việc của chính họ (RLS). Không sửa tay bảng này |
| Gói dịch vụ, giới hạn kết nối, dung lượng | Hai app chia chung hạn mức | Giữ truy vấn gọn: không `SELECT *`, có `LIMIT`, có index |
| Database > Extensions: `pg_cron`, `pg_net` | Bật cho cả database | Kiểm tra đã bật chưa. Nếu chưa, báo người phụ trách project kia trước khi bật. Không tắt khi đang có job của project kia |
| Edge Functions > Secrets | Dùng chung cho mọi function | Chỉ thêm biến có tiền tố `VIEC_CUA_TOI_`. Không sửa, không xoá biến khác. Lệnh `supabase secrets set` chỉ ghi các biến được liệt kê, nhưng kiểm tra kỹ tên trước khi chạy |
| Hạn mức gọi Edge Function | Tính chung cho project | Bộ nhắc chạy 5 phút một lần, khoảng 8.600 lần mỗi tháng. Không giảm xuống dưới 1 phút |

## Quy tắc khi thay đổi database

| # | Quy tắc |
|---|---|
| 1 | Mọi thay đổi schema phải là file migration mới trong `supabase/migrations/`, có file rollback tương ứng trong `supabase/rollback/`, được review trước khi chạy |
| 2 | Migration chỉ được tạo, sửa đối tượng trong schema `viec_cua_toi`. Không dùng `DROP ... CASCADE` ngoài schema này |
| 3 | Không xoá cứng dữ liệu. Xoá là đặt `is_deleted = TRUE`; trigger tự điền `deleted_at`, `deleted_by`. Lệnh `DELETE` bị chặn bằng trigger |
| 4 | Không sửa tay dữ liệu production qua Table Editor. Mọi lần sửa dữ liệu phải qua script đã review và ghi chép lại |
| 5 | Không đổi tên hay xoá cột ngay. Thêm cột mới, chuyển dữ liệu, cập nhật app, rồi mới bỏ cột cũ |
| 6 | Mọi thay đổi trên `tasks` tự ghi vào `audit_log` (giá trị cũ, mới, người đổi, thời điểm). Không xoá bảng này |
| 7 | Chạy thử migration trên môi trường thử (project Supabase riêng hoặc `supabase start` ở máy) trước khi chạy trên database thật |
| 8 | Sao lưu riêng schema của app trước mỗi migration: `pg_dump "$DATABASE_URL" --schema=viec_cua_toi > backup.sql` |
| 9 | App chỉ dùng **anon key**. Không đưa `service_role` key vào code, vào GitHub hay vào biến `VITE_*` |
| 10 | Rollback (`DROP SCHEMA viec_cua_toi CASCADE`) xoá toàn bộ dữ liệu của app. Chỉ chạy khi đã sao lưu và chắc chắn |
| 11 | Gỡ theo thứ tự ngược: lịch chạy (`supabase/cron/*.down.sql`) trước, rồi mới tới rollback của migration |
| 12 | Khoá bí mật VAPID và chuỗi bí mật cron chỉ nằm trong Supabase secrets và Vault, không đưa vào code hay GitHub |

## Kiểm tra nhanh sau khi chạy migration

```sql
-- Chỉ có đối tượng trong schema viec_cua_toi được tạo
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = 'viec_cua_toi';

-- RLS đang bật
SELECT relname, relrowsecurity
FROM pg_class
WHERE relnamespace = 'viec_cua_toi'::regnamespace AND relkind = 'r';

-- Bảng nằm trong publication realtime
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'viec_cua_toi';

-- Lịch chạy nhắc việc (sau khi chạy supabase/cron/viec_cua_toi_reminders.sql)
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'viec_cua_toi_reminders';

-- 10 lần chạy gần nhất của job
SELECT status, return_message, start_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'viec_cua_toi_reminders')
ORDER BY start_time DESC
LIMIT 10;

-- Kết quả gửi nhắc việc gần đây
SELECT kind, remind_at, status, devices_sent, detail
FROM viec_cua_toi.reminder_log
ORDER BY id DESC
LIMIT 20;
```
