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

- **Tự điền trên máy tính cần cài extension** (xem bên dưới). Web app không tự điền được vào trang
  khác.
- **Trên điện thoại chưa có tự điền.** Tạm thời, mở cùng file `kaipass.kdbx` trên Google Drive bằng
  KeePassium (iOS) hoặc KeePassDX / Keepass2Android (Android).
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
7. Ghi Client ID vào `src/config.ts` (repo này đã ghi sẵn Client ID của chủ repo).

### 2. Đưa app lên GitHub Pages

Mỗi lần push lên `main`, workflow `.github/workflows/publish.yml` build app rồi đẩy bản build vào
nhánh `gh-pages`.

1. **Settings → Secrets and variables → Actions → Variables**: tạo biến `GOOGLE_CLIENT_ID` với
   Client ID ở trên, nếu muốn dùng Client ID khác với `src/config.ts`. Không bắt buộc.
2. **Settings → Pages → Source: Deploy from a branch**, chọn nhánh `gh-pages`, thư mục `/ (root)`.
3. App chạy tại `https://<tên-github>.github.io/<tên-repo>/`.

GitHub Pages cho repo private cần gói GitHub trả phí. Nếu bạn dùng gói Free, hãy chuyển repo sang
public (mã nguồn không chứa dữ liệu của bạn), hoặc dùng Cloudflare Pages với thư mục build `dist`.

### 3. Dùng

1. Mở app, chọn **Lưu trên Google Drive**, đăng nhập Google, đặt master password.
2. Trên thiết bị khác: mở cùng địa chỉ, chọn **Lưu trên Google Drive**, nhập master password.
3. Cài như app: trên Chrome/Edge bấm biểu tượng cài đặt ở thanh địa chỉ; trên iPhone dùng
   Safari → Chia sẻ → **Thêm vào MH chính**.

## Extension trình duyệt (tự điền mật khẩu và OTP)

Dùng cho Chrome, Edge, Brave trên Mac, Windows, Linux.

### Cài

1. Tải `kaipass-extension.zip` ở mục **Releases → Bản build mới nhất** của repo, giải nén.
   (Hoặc tự build: `npm run build:ext`, kết quả nằm ở `dist-ext/`.)
2. Mở `chrome://extensions`, bật **Developer mode**, bấm **Load unpacked**, chọn thư mục vừa giải nén.
3. Ghim biểu tượng KaiPass lên thanh công cụ.
4. Để extension đồng bộ Google Drive, vào OAuth client đã tạo ở trên và thêm vào
   **Authorized redirect URIs**: `https://eokdpgifmehmgjoelmomohkajehodpeg.chromiumapp.org/`
5. Bấm biểu tượng KaiPass, chọn **Lưu trên Google Drive**, đăng nhập, nhập master password.

### Dùng

- **Trong ô đăng nhập:** bấm vào ô tên đăng nhập, mật khẩu hoặc mã OTP. Biểu tượng KaiPass hiện ở
  mép phải ô, kèm danh sách tài khoản đã lưu cho trang đó; chọn một tài khoản là điền. Bấm biểu
  tượng (hoặc phím mũi tên xuống) để mở lại danh sách.
- **Hỏi lưu:** khi bạn đăng nhập bằng tài khoản chưa có trong KaiPass, hoặc đổi mật khẩu, một thẻ
  ở góc trên hỏi **Lưu** / **Cập nhật**. Với form đăng nhập hai bước (nhập email trước, mật khẩu
  sau), KaiPass nhớ tên đăng nhập ở bước đầu. Chọn **Không bao giờ cho trang này** để tắt hỏi ở một
  trang. Chỉ hỏi khi KaiPass đang mở khoá.
- **Thẻ gợi ý ở góc trên:** khi trang có ô đăng nhập và bạn đã lưu tài khoản cho trang đó, một thẻ
  "Đăng nhập bằng KaiPass" hiện ở góc trên bên phải; bấm vào tài khoản để điền.
- **Từ thanh công cụ:** bấm biểu tượng KaiPass (hoặc `Ctrl+Shift+L`, trên Mac là `Cmd+Shift+L`),
  bấm **Điền** ở tài khoản muốn dùng.
- Mã OTP được điền khi trang có ô nhập mã. Nếu ô đó ở bước sau, bấm vào ô và chọn tài khoản lần nữa.
- Một tài khoản chỉ được gợi ý khi ô "Địa chỉ web" của nó trùng tên miền với trang đang mở.
- Khi KaiPass đang khoá, danh sách trong ô có nút **Mở khoá**.
- Tắt biểu tượng hoặc thẻ gợi ý trong **Cài đặt → Gợi ý trên trang web**.

### Cần biết

- Để gợi ý được ngay trên trang, extension chạy một đoạn mã nhỏ trên mọi trang web, giống
  1Password, nên Chrome sẽ báo extension "đọc và thay đổi dữ liệu trên các trang web". Đoạn mã đó
  không giữ mật khẩu: nó chỉ được biết tên và tên đăng nhập của các tài khoản khớp với trang, và chỉ
  nhận mật khẩu khi bạn bấm chọn một tài khoản. Phần giao diện nằm trong vùng mà trang web không đọc
  được, và chỉ phản hồi cú bấm thật của bạn, không phản hồi cú bấm giả do trang tạo ra.
- Mật khẩu chỉ được điền vào trang hoặc khung (iframe) có tên miền khớp với địa chỉ đã lưu.
- Để không phải gõ master password mỗi lần, extension giữ nó (và danh sách tài khoản dùng để điền)
  trong bộ nhớ tạm của trình duyệt, không ghi xuống đĩa, cho tới khi hết thời gian tự khoá, bấm
  **Khoá**, hoặc đóng trình duyệt.
- Khi đang mở khoá, extension tự đồng bộ với Drive mỗi 15 phút và khi bạn vào một trang đăng nhập
  (nếu lần đồng bộ trước đã quá 5 phút), nên gợi ý có cả thay đổi làm trên thiết bị khác.
- Việc lưu từ trang web và đồng bộ nền chạy trong phần chạy ngầm của extension, dùng bản vault trên
  máy bạn và master password đang giữ trong bộ nhớ tạm. Cửa sổ KaiPass đang mở sẽ tự thấy thay đổi.
- Extension và web app là hai bản cài riêng, cùng đồng bộ với một file trên Drive.

## Chia sẻ

Trong một mục, bấm biểu tượng **Chia sẻ**, chọn thời hạn (1 giờ đến 30 ngày), có thể đặt thêm
**mật khẩu chia sẻ**, rồi **Tạo link**. Người nhận mở link bằng trình duyệt, không cần cài KaiPass,
và có thể bấm **Lưu vào KaiPass của bạn**. Người dùng KaiPass cũng có thể dán link vào
**Thêm → Từ link chia sẻ…**.

- Dữ liệu được mã hoá AES-256 bằng một khoá ngẫu nhiên. Khoá chỉ nằm ở phần sau dấu `#` của link,
  phần mà trình duyệt không bao giờ gửi lên máy chủ nào. Thời hạn được gắn vào dữ liệu mã hoá nên
  không sửa được.
- Có mật khẩu chia sẻ thì link thôi là chưa đủ để mở. Hãy gửi mật khẩu qua kênh khác với link.
- File đính kèm không được chia sẻ.
- Link mở ở địa chỉ web app (mặc định `https://thanhkaiba.github.io/kaipass/`, sửa trong
  `src/config.ts`), nên web app phải được đưa lên mạng (xem phần GitHub Pages).

Có hai loại link:

| | Link qua Google Drive | Link tự chứa |
|---|---|---|
| Dữ liệu (đã mã hoá) nằm ở | Một file trên Drive của bạn, ai có link mới đọc được | Ngay trong link |
| Thu hồi | Được: bấm **Thu hồi**, file bị xoá | Không |
| Hết hạn | File bị xoá ở lần mở KaiPass hoặc đồng bộ nền đầu tiên sau hạn; trình xem cũng từ chối | Chỉ trình xem của KaiPass từ chối; ai giải mã thủ công vẫn đọc được |
| Cần | Vault lưu trên Drive và một Google API key (bên dưới) | Không cần gì |

KaiPass tự dùng link qua Drive khi đủ điều kiện, không thì dùng link tự chứa. Tài khoản Google công
ty thường cấm chia sẻ file công khai; khi đó KaiPass báo rõ và cho tạo link tự chứa.

### Bật link thu hồi được (Google API key)

1. Google Cloud Console, cùng project → **APIs & Services → Credentials → Create credentials →
   API key**.
2. Bấm vào key vừa tạo. **API restrictions**: chọn **Restrict key**, tích **Google Drive API**.
   **Application restrictions**: chọn **Websites**, thêm `https://thanhkaiba.github.io/*`.
3. Ghi key vào `src/config.ts` (`GOOGLE_API_KEY`), hoặc tạo biến `GOOGLE_API_KEY` ở **Settings →
   Secrets and variables → Actions → Variables** của repo. Key này không phải bí mật: nó chỉ dùng để
   đọc file đã được chia sẻ công khai, và chỉ chạy từ địa chỉ bạn cho phép.

Link chia sẻ từ 1Password không mở được trong KaiPass: mở link đó trong trình duyệt rồi copy từng mục.
Với OTP, nhờ người gửi kèm chuỗi `otpauth://`.

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
npm run dev        # web app tại http://localhost:5173
npm test           # phần lõi: mã hoá, OTP, nhập 1Password, gộp dữ liệu
npm run build      # web app → dist/
npm run build:ext  # extension → dist-ext/
VITE_GOOGLE_API_KEY=test-key npm run build && npm run e2e   # web app trên Chromium (cần Playwright)
KAIPASS_TEST_HOSTS=1 npm run build:ext && npm run e2e:ext   # extension trên Chromium
```

Hai bộ `e2e` thay Google bằng bản giả lập, nên chúng kiểm tra logic đồng bộ và tự điền của app chứ
không kiểm tra được việc đăng nhập Google thật. Bản build extension dùng cho `e2e:ext` được cấp
thêm quyền truy cập `localhost`; đừng dùng bản đó để cài thật.

Mã nguồn chính:

- `src/lib/vault.ts`: đọc/ghi file KeePass
- `src/lib/session.ts`: lưu bản sao trên thiết bị và đồng bộ với Drive
- `src/lib/drive.ts`: đăng nhập Google và gọi Drive API
- `src/lib/onepux.ts`: nhập file 1Password
- `src/lib/totp.ts`: mã OTP
- `src/lib/share.ts`: link chia sẻ (mã hoá, hai loại link, thu hồi)
- `src/ext/`: phần riêng của extension: `background.ts` (service worker), `content.ts` (gợi ý trên
  trang), `fill.ts` (điền vào form)
- `src/ui/`: giao diện
- `extension/manifest.json`: khai báo extension
