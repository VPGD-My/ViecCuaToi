# Việc của tôi

App quản lý công việc cá nhân trên điện thoại, chia hai nhóm **Công việc** và **Cá nhân**, giao diện tử đằng và mèo tròn màu nước.

- Giao diện: HTML, CSS, JavaScript thuần, đóng gói bằng Vite
- Dữ liệu và đăng nhập: Supabase (schema riêng `viec_cua_toi`, Row Level Security, xoá mềm, audit log)
- Triển khai: GitHub Pages qua GitHub Actions (hoặc Vercel, Netlify)
- Cài lên màn hình chính điện thoại như app thật (PWA)

> Database dùng chung với project khác. Đọc kỹ [docs/LUU-Y-DATABASE.md](docs/LUU-Y-DATABASE.md) trước khi thay đổi bất cứ thứ gì trên Supabase.

## Cấu trúc

```
index.html                     Khung giao diện
src/main.js                    Logic giao diện
src/store.js                   Toàn bộ đọc/ghi Supabase
src/style.css                  Giao diện sáng/tối, khung điện thoại trên màn hình rộng
public/                        Icon, manifest để cài lên điện thoại
supabase/migrations/           Migration có version
supabase/rollback/             Script rollback tương ứng
supabase/functions/            Edge Function gửi nhắc việc
supabase/cron/                 Lịch chạy bộ nhắc việc (pg_cron)
public/sw.js                   Service worker nhận thông báo
docs/LUU-Y-DATABASE.md         Lưu ý khi dùng chung database
.github/workflows/deploy.yml   Tự build và đưa lên GitHub Pages
```

## Cài đặt lần đầu

### 1. Tạo database

1. Sao lưu trước (khuyến nghị): `pg_dump "$DATABASE_URL" --schema-only > backup_truoc_khi_cai.sql`
2. Mở Supabase Dashboard > SQL Editor, dán và chạy toàn bộ file `supabase/migrations/20261114000001_init_viec_cua_toi.sql`.
   Hoặc dùng Supabase CLI: `supabase db push` (khi repo đã được `supabase link` tới project).
3. Vào **Project Settings > Data API > Exposed schemas**, **thêm** `viec_cua_toi`, giữ nguyên các schema đang có.
4. Vào **Authentication > URL Configuration > Redirect URLs**, **thêm** địa chỉ app (ví dụ `https://<tai-khoan>.github.io/viec-cua-toi/**` và `http://localhost:5173/**`). Không đổi Site URL.
5. Chạy các câu kiểm tra ở cuối file `docs/LUU-Y-DATABASE.md`.

### 2. Chạy ở máy

```bash
npm install
cp .env.example .env.local   # điền VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY
npm run dev
```

### 3. Đưa lên GitHub và chạy online

```bash
git init
git add .
git commit -m "Việc của tôi: phiên bản đầu tiên"
git branch -M main
git remote add origin https://github.com/<tai-khoan>/viec-cua-toi.git
git push -u origin main
```

Sau đó trên GitHub:

1. **Settings > Secrets and variables > Actions**: tạo secret `VITE_SUPABASE_URL` và `VITE_SUPABASE_ANON_KEY`.
2. **Settings > Pages > Source**: chọn **GitHub Actions**.
3. Mỗi lần đẩy code lên nhánh `main`, app tự build và cập nhật tại `https://<tai-khoan>.github.io/viec-cua-toi/`.

Muốn dùng Vercel hoặc Netlify: kết nối repo, lệnh build `npm run build`, thư mục `dist`, khai báo hai biến môi trường như trên.

### 4. Bật nhắc việc (thông báo trên điện thoại)

Quy tắc nhắc:

| Việc | Thời điểm nhắc |
|---|---|
| Có ngày và giờ hạn | Trước giờ hạn 15 phút (đổi bằng `VIEC_CUA_TOI_REMIND_BEFORE_MIN`, đặt `0` để nhắc đúng giờ) |
| Chỉ có ngày hạn | 07:30 sáng ngày đó (đổi bằng `VIEC_CUA_TOI_MORNING_TIME`) |
| Không có hạn, đã xong, đã xoá | Không nhắc |

Bộ nhắc chạy 5 phút một lần nên thông báo có thể đến sớm hoặc trễ tối đa khoảng 5 phút. Giờ nhắc tính theo múi giờ của điện thoại đã bật nhắc. Đổi giờ hạn thì việc được nhắc lại theo giờ mới.

Cài đặt:

1. Chạy migration `supabase/migrations/20261119000002_push_reminders.sql`.
2. Tạo khoá VAPID: `npx web-push generate-vapid-keys`.
3. Đặt secret cho Edge Function (chỉ biến có tiền tố `VIEC_CUA_TOI_`, không đụng biến của project kia):
   ```bash
   supabase secrets set \
     VIEC_CUA_TOI_VAPID_PUBLIC_KEY=<khoá công khai> \
     VIEC_CUA_TOI_VAPID_PRIVATE_KEY=<khoá bí mật> \
     VIEC_CUA_TOI_VAPID_SUBJECT=mailto:<email của bạn> \
     VIEC_CUA_TOI_CRON_SECRET=<chuỗi ngẫu nhiên dài, ví dụ từ: openssl rand -hex 32> \
     VIEC_CUA_TOI_REMIND_BEFORE_MIN=15 \
     VIEC_CUA_TOI_MORNING_TIME=07:30
   ```
4. Deploy function: `supabase functions deploy viec-cua-toi-reminders --no-verify-jwt`.
   Function tự kiểm tra header `x-cron-secret` nên không cần JWT.
5. Đọc mục pg_cron trong `docs/LUU-Y-DATABASE.md`, điền 2 giá trị trong `supabase/cron/viec_cua_toi_reminders.sql` rồi chạy trong SQL Editor.
6. Thêm secret `VITE_VAPID_PUBLIC_KEY` (khoá công khai) vào GitHub Actions rồi đẩy code để build lại.
7. Trên điện thoại: cài app vào màn hình chính, mở app, bấm **Bật** ở thẻ gợi ý hoặc nút chuông, chọn Cho phép.

Điều kiện: iPhone cần iOS 16.4 trở lên và phải mở app từ màn hình chính. Android dùng Chrome.

Kiểm tra nhanh: tạo một việc có giờ hạn khoảng 20 phút nữa, đợi tối đa 10 phút. Xem kết quả ở bảng `viec_cua_toi.reminder_log`.

### 5. Cài lên điện thoại

Mở địa chỉ app bằng Safari (iPhone) hoặc Chrome (Android), bấm Chia sẻ > **Thêm vào MH chính**.

## Tính năng

- Đăng nhập bằng email và mật khẩu, quên mật khẩu qua email
- Hai nhóm Công việc, Cá nhân và chế độ xem Tất cả
- Hạn ngày giờ, mức ưu tiên, các bước nhỏ, ghi chú, tìm kiếm
- Việc quan trọng có nhãn mèo; mèo hồng lo lắng khi quá hạn, mèo vàng vui vẻ khi còn hạn
- Nhắc việc bằng thông báo trên điện thoại: theo giờ hạn, hoặc buổi sáng nếu chỉ có ngày
- Đồng bộ thời gian thực giữa các thiết bị
- Giao diện sáng, tối hoặc theo máy
- Trên màn hình rộng, app hiển thị trong khung điện thoại

## Dữ liệu

- `viec_cua_toi.tasks`: mỗi dòng là một việc, có đủ cột audit (`created_*`, `updated_*`) và xoá mềm (`is_deleted`, `deleted_*`)
- `viec_cua_toi.audit_log`: mọi thêm, sửa, xoá, khôi phục đều được trigger ghi lại kèm giá trị cũ và mới
- `viec_cua_toi.push_subscriptions`: thiết bị đã bật nhắc việc (xoá mềm khi tắt nhắc, đăng xuất, hoặc khi thiết bị gỡ quyền)
- `viec_cua_toi.reminder_log`: mỗi lần nhắc một dòng, có ràng buộc chống gửi trùng
- Người dùng chỉ đọc, ghi được việc của chính mình (RLS). Quyền `DELETE` không được cấp, và trigger chặn xoá cứng
