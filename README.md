# KaiPass

Trình quản lý mật khẩu cá nhân chạy hoàn toàn trong trình duyệt. Dữ liệu là một file KeePass
(`.kdbx`) được mã hoá bằng master password ngay trên thiết bị, rồi lưu lên Google Drive của chính
bạn. Không có server, không có phí hằng tháng.

## Có gì

- Lưu đăng nhập, thẻ, giấy tờ, ghi chú bảo mật, kèm file đính kèm (ảnh CCCD, recovery key…).
- Mã OTP (TOTP): dán chuỗi `otpauth://…` hoặc secret key.
- Nhập dữ liệu từ 1Password (file `.1pux`), gồm cả OTP, trường tuỳ chỉnh và file đính kèm.
- Đồng bộ qua Google Drive, tự gộp khi hai thiết bị cùng sửa. Mất mạng vẫn xem và sửa được.
- Cài như app trên Mac, Windows, iPhone, Android (PWA).
- Tạo mật khẩu, tìm kiếm, thư mục, nhãn, yêu thích, thùng rác, tự khoá.
- File `.kdbx` mở được bằng KeePassXC, KeePassium, KeePassDX… nên bạn không bị khoá vào app này.

## Giới hạn cần biết

- **Web app không tự điền được vào app hay trang web khác.** Trên điện thoại, muốn tự điền thì mở
  cùng file `kaipass.kdbx` trên Google Drive bằng KeePassium (iOS) hoặc KeePassDX / Keepass2Android
  (Android). Trên máy tính, dùng nút copy.
- **Quên master password là mất dữ liệu.** Không có cách khôi phục.
- Phiên đăng nhập Google hết hạn sau khoảng một giờ. Khi đó app vẫn dùng được, chỉ cần bấm
  "Đăng nhập Google để đồng bộ" một lần.
- App chỉ thấy file do chính nó tạo trên Drive (quyền `drive.file`). Vì vậy hãy tạo vault từ app
  này trước, rồi mới mở file đó bằng app KeePass khác.

## Bảo mật

- Mã hoá theo chuẩn KDBX 4: khoá dẫn xuất bằng Argon2id (64 MiB, 3 vòng), dữ liệu mã hoá AES-256.
  Phần mã hoá do thư viện `kdbxweb` và `hash-wasm` đảm nhiệm, app không tự chế thuật toán.
- Google Drive và bộ nhớ trình duyệt chỉ giữ file đã mã hoá. Master password không được lưu ở đâu.
- Bản build có Content-Security-Policy: trang chỉ chạy code của chính nó và chỉ kết nối tới Google.
- Đây là dự án cá nhân, chưa qua kiểm định bảo mật độc lập. Máy có mã độc hoặc tiện ích trình duyệt
  độc hại vẫn đọc được dữ liệu khi vault đang mở.

## Cài đặt

### 1. Tạo Google OAuth Client ID (miễn phí, làm một lần)

Tên menu trong Google Cloud Console có thể thay đổi đôi chút.

1. Vào <https://console.cloud.google.com>, tạo một project mới.
2. **APIs & Services → Library**: bật **Google Drive API**.
3. **Google Auth Platform** (màn hình OAuth consent): điền tên app, email, chọn **External**.
   Ở mục **Audience**, thêm Gmail của bạn vào **Test users**, hoặc bấm **Publish app**.
4. **Data Access**: thêm scope `https://www.googleapis.com/auth/drive.file`.
5. **Clients → Create client → Web application**. Ở **Authorized JavaScript origins**, thêm địa chỉ
   nơi bạn chạy app, ví dụ `https://<tên-github>.github.io` và `http://localhost:5173`.
6. Copy **Client ID** (dạng `1234…apps.googleusercontent.com`). Đây không phải bí mật.

### 2. Đưa app lên GitHub Pages

1. Trong repo: **Settings → Pages → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**: tạo biến `GOOGLE_CLIENT_ID` với
   Client ID ở trên. Nếu bỏ qua bước này, app sẽ hỏi Client ID khi kết nối Drive.
3. Push lên nhánh `main`. Workflow `.github/workflows/deploy.yml` sẽ build và đăng app tại
   `https://<tên-github>.github.io/<tên-repo>/`.

### 3. Dùng

1. Mở app, chọn **Lưu trên Google Drive**, đăng nhập Google, đặt master password.
2. Trên thiết bị khác: mở cùng địa chỉ, chọn **Lưu trên Google Drive**, nhập master password.
3. Cài như app: trên Chrome/Edge bấm biểu tượng cài đặt ở thanh địa chỉ; trên iPhone dùng
   Safari → Chia sẻ → **Thêm vào MH chính**.

## Chuyển từ 1Password

1. App 1Password trên máy tính: **File → Export**, chọn tài khoản, định dạng **1PUX**.
2. Trong KaiPass: **Cài đặt → Nhập từ 1Password**, chọn file vừa xuất.
3. Kiểm tra lại vài mục, nhất là OTP và file đính kèm. Passkey không xuất được, phải đăng ký lại
   trên từng trang.
4. Xoá file `.1pux` (nó chứa mật khẩu chưa mã hoá).

Khi người khác chia sẻ một mục từ 1Password kèm OTP, hãy nhờ họ gửi chuỗi `otpauth://…` (trong
1Password: Edit mục đó, copy nội dung ô one-time password), rồi dán vào ô "Mã bí mật OTP".

## Phát triển

```sh
npm install
npm run dev        # chạy tại http://localhost:5173
npm test           # kiểm tra phần lõi: mã hoá, OTP, nhập 1Password, gộp dữ liệu
npm run build
npm run e2e        # kiểm tra trên trình duyệt thật (cần Playwright + Chromium)
```

`npm run e2e` thay Google bằng bản giả lập, nên nó kiểm tra logic đồng bộ của app chứ không kiểm tra
được việc đăng nhập Google thật.

Mã nguồn chính:

- `src/lib/vault.ts`: đọc/ghi file KeePass
- `src/lib/session.ts`: lưu bản sao trên thiết bị và đồng bộ với Drive
- `src/lib/drive.ts`: đăng nhập Google và gọi Drive API
- `src/lib/onepux.ts`: nhập file 1Password
- `src/lib/totp.ts`: mã OTP
- `src/ui/`: giao diện
