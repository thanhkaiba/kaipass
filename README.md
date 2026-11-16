# KaiPass

Trình quản lý mật khẩu cá nhân chạy hoàn toàn trong trình duyệt. Dữ liệu là một file KeePass
(`.kdbx`) được mã hoá bằng master password ngay trên thiết bị, rồi lưu lên Google Drive của chính
bạn. Không có server, không có phí hằng tháng.

## Có gì

- Lưu đăng nhập, thẻ, giấy tờ, ghi chú bảo mật, kèm file đính kèm (ảnh CCCD, recovery key…).
- Mã OTP (TOTP): quét mã QR mà không cần camera (mã QR đang hiện trên trang, ảnh chụp màn hình
  dán bằng Ctrl/⌘+V, file ảnh, hoặc camera nếu có), hoặc dán chuỗi `otpauth://…` / secret key.
  Đọc được cả mã "Export accounts" của Google Authenticator (thêm mọi tài khoản cùng lúc).
- Nhập dữ liệu từ 1Password (file `.1pux`), gồm cả OTP, trường tuỳ chỉnh và file đính kèm.
- Đồng bộ qua Google Drive, tự gộp khi hai thiết bị cùng sửa. Mất mạng vẫn xem và sửa được.
- Cài như app trên Mac, Windows, iPhone (PWA). Trên Android có app riêng (APK) tự điền mật khẩu
  và OTP vào mọi app và trình duyệt.
- Tạo mật khẩu, tìm kiếm, thư mục, nhãn, yêu thích, thùng rác, tự khoá.
- File `.kdbx` mở được bằng KeePassXC, KeePassium, KeePassDX… nên bạn không bị khoá vào app này.

## Giới hạn cần biết

- **Tự điền trên máy tính cần cài extension** (xem bên dưới). Web app không tự điền được vào trang
  khác.
- **iPhone chưa có tự điền.** Tạm thời, mở cùng file `kaipass.kdbx` trên Google Drive bằng
  KeePassium. Android thì dùng app KaiPass (xem phần Android).
- **Quên master password mà chưa tạo khoá khôi phục là mất dữ liệu.** Xem phần khoá khôi phục.
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
- Một tài khoản được gợi ý khi địa chỉ đã lưu cùng **site** với trang (ví dụ mọi trang
  `*.amazon.com`), xếp địa chỉ giống nhất lên trước. "Site" theo Public Suffix List, nên
  `ai-do.github.io` và `ke-xau.github.io` là hai site khác nhau, và không bao giờ gợi ý trên
  `amazon.com.evil.net`.
- Danh sách mật khẩu Chrome tự lưu là giao diện của trình duyệt, luôn nằm trên trang, và extension
  không ẩn được nó. Danh sách KaiPass vì vậy mở phía trên ô nhập. Muốn Chrome thôi hiện, xoá các mật
  khẩu đó trong `chrome://password-manager` (Cài đặt → Gợi ý trên web có nút mở), và tắt "Chrome hỏi
  lưu mật khẩu" để chỉ KaiPass hỏi.
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

## App Android (tự điền mật khẩu và OTP)

App Android là KaiPass đóng gói sẵn, cộng thêm phần chạy riêng trên điện thoại: dịch vụ tự điền
của Android, mở khoá bằng vân tay/khuôn mặt/mã PIN, và đăng nhập Google qua Google Play.

### Cài

1. Một lần trong Google Cloud Console (cùng project với Client ID web): **APIs & Services →
   Credentials → Create credentials → OAuth client ID → Android**, rồi điền:
   - Package name: `io.github.thanhkaiba.kaipass`
   - SHA-1: `DC:A5:E3:99:95:80:99:14:63:3A:AC:89:71:F8:B4:53:BC:2A:D9:37`

   Google nhận ra app qua cặp này, nên không cần dán Client ID vào app. Nếu app còn ở chế độ
   Testing, tài khoản Google của bạn phải nằm trong danh sách Test users như với bản web.
2. Tải `kaipass.apk` (release "builds" trên GitHub, hoặc file được gửi kèm), mở trên điện thoại,
   cho phép "Cài app không rõ nguồn gốc" khi Android hỏi.
3. Mở KaiPass → **Lưu trên Google Drive** → **Đăng nhập Google** → nhập master password. Vault
   có sẵn trên Drive sẽ được tải về.
4. **Cài đặt → Tự điền → Bật** rồi chọn KaiPass. Với Chrome: Cài đặt → Dịch vụ tự động điền →
   *Tự động điền bằng dịch vụ khác*. Firefox, Brave, Edge, Cốc Cốc và Samsung Internet dùng được ngay.
5. **Cài đặt → Bảo mật → Vân tay / mật khẩu máy** để mở khoá không cần gõ master password.

### Dùng

- Chạm vào ô đăng nhập trong app hoặc trang web: tài khoản khớp hiện ngay trên bàn phím (Android 11+)
  hoặc trong danh sách thả xuống. Chạm là điền tên đăng nhập và mật khẩu.
- Ô mã OTP được điền mã mới nhất. Nếu trang hỏi OTP ở bước sau, mã đã được chép sẵn để dán.
- Khi vault đang khoá: chạm **Mở khoá KaiPass**, mở bằng vân tay, các tài khoản khớp hiện ra.
- Không có tài khoản khớp (ví dụ app ngân hàng có tên khác website): chọn **Tìm trong KaiPass…**,
  chọn tài khoản. KaiPass nhớ lựa chọn đó cho app này.
- Đăng nhập bằng tài khoản mới hoặc đổi mật khẩu: Android hỏi "Lưu vào KaiPass?". KaiPass mở lên,
  hỏi lưu mới hay cập nhật mục cũ, xong thì quay về app đang dùng.
- Mở link chia sẻ KaiPass: trong Zalo/Messenger bấm Chia sẻ → KaiPass.

### Cần biết

- Danh sách tài khoản cho tự điền chỉ nằm trong bộ nhớ của app khi vault đang mở. Nó bị xoá khi
  vault khoá, hoặc sau thời gian tự khoá kể cả khi app chạy nền.
- KaiPass chặn chụp màn hình và ảnh xem trước trong danh sách app gần đây.
- Mở khoá bằng vân tay: master password được mã hoá bằng khoá trong chip bảo mật của điện thoại, chỉ
  dùng được ngay sau khi bạn qua bước vân tay/PIN. Thêm vân tay mới thì phải bật lại.
- Bản cập nhật phải được ký bằng cùng một khoá (file `kaipass-release.jks`). Mất khoá thì phải gỡ
  app rồi cài lại, và tạo lại OAuth client Android với SHA-1 mới. Để GitHub Actions tự build APK,
  thêm hai secret ở Settings → Secrets and variables → Actions:
  `ANDROID_KEYSTORE_B64` (nội dung `base64 -w0 kaipass-release.jks`) và `ANDROID_KEYSTORE_PASSWORD`.

## Dán tin nhắn (Claude AI)

**Thêm → Dán tin nhắn (Claude)…**: dán nguyên tin nhắn Slack/Zalo/email có thông tin tài khoản, có thể
kèm ảnh chụp màn hình (Ctrl/⌘+V). Claude tách thành tên, tên đăng nhập, mật khẩu, OTP, địa chỉ web và
các trường khác. Một tài khoản thì mở sẵn trình sửa để bạn xem lại; nhiều tài khoản thì hiện danh sách
để chọn. Không có gì được lưu khi bạn chưa xem.

- Cần Claude API key (console.anthropic.com → API Keys). Nhập lần đầu khi dùng, hoặc ở **Cài đặt →
  Claude AI**. Key được kiểm tra trước, rồi lưu **trong vault** (đã mã hoá) và đồng bộ cùng vault.
- Mô hình mặc định Claude Opus 5.5; đổi sang Sonnet 5.5 hoặc Haiku 5.5 (rẻ hơn) trong Cài đặt.
- Với Opus và Sonnet, yêu cầu bật dự phòng phía máy chủ (`fallbacks: "default"`): nếu mô hình từ chối
  nhầm một tin nhắn chứa mật khẩu, API tự chạy lại trên mô hình dự phòng.
- **Chỉ nội dung bạn dán** được gửi tới Anthropic, và chỉ khi bạn bấm nút. Vault không bao giờ được gửi.
  Gọi thẳng từ thiết bị tới `api.anthropic.com`, không qua máy chủ nào khác.

## Giao diện

**Cài đặt → Giao diện**: chọn bộ icon (KaiPass, Lucide, Phosphor, Phosphor Duotone, Phosphor Fill,
Pixel, Emoji) và màu chủ đạo. Lựa chọn lưu theo từng thiết bị. Các bộ icon là mã nguồn mở, xem
`THIRD-PARTY-NOTICES.md`.

### Logo trang web

- **Logo có sẵn** cho hơn 200 trang nổi tiếng (Google, Gmail, GitHub, Bitbucket, Linear, Apple, Shopee, Zalo, Notion…). App nhận ra trang theo địa chỉ web của mục (kể cả `shopee.vn`, `google.com.vn`; `mail.google.com` ra Gmail), hoặc theo tên mục và chữ viết tắt ("GitHub - công ty", "Visa VCB"). Không cần mạng. Logo lấy từ [Simple Icons](https://simpleicons.org) (CC0). Vài hãng (Microsoft, LinkedIn, Amazon/AWS, OpenAI, Slack…) đã yêu cầu Simple Icons gỡ logo, và các ngân hàng hay ví Việt Nam (Vietcombank, Techcombank, MoMo…) không có trong bộ đó. Những trang này hiện ô màu thương hiệu kèm chữ cái. Tắt được ở Cài đặt → Giao diện.
- **Tải icon cho các trang khác** (mặc định tắt): lấy icon *từ chính trang web* hoặc *qua DuckDuckGo*. Bật lên thì mạng bạn đang dùng (hoặc DuckDuckGo) sẽ thấy danh sách tên trang trong vault, nên tuỳ chọn này để tắt sẵn.
- **Tìm logo bằng Claude**: liệt kê các mục chưa có logo, rồi nhờ Claude đoán mỗi mục thuộc trang nào. Claude chỉ nhận tên mục và tên trang, không nhận tài khoản, mật khẩu hay ghi chú. Bạn duyệt rồi bấm lưu. Logo đã gán nằm trong vault, đồng bộ sang các máy khác, và gỡ được bất cứ lúc nào.

## Mở khoá nhanh và quên master password

### Vân tay / mật khẩu máy

**Cài đặt → Mở khoá nhanh và khôi phục**: nhập master password hiện tại, bấm **Bật** ở dòng
"Vân tay / mật khẩu máy". Từ đó màn hình khoá có nút mở bằng Touch ID, Windows Hello, vân tay điện
thoại, hoặc mật khẩu / PIN của máy.

- Chỉ áp dụng cho thiết bị đang dùng; mỗi thiết bị bật riêng.
- Cách làm: KaiPass tạo một passkey trên thiết bị (WebAuthn, tính năng PRF). Mỗi lần bạn qua bước
  vân tay hoặc PIN, thiết bị trả về một bí mật dùng để giải mã master password đã lưu (đã mã hoá) trên
  máy. Không qua bước đó thì không đọc được.
- Cần trình duyệt và hệ điều hành hỗ trợ WebAuthn PRF (Chrome bản mới trên macOS, Windows,
  Android). Nếu không hỗ trợ, KaiPass báo khi bạn bấm Bật.
- Đổi master password sẽ tắt tính năng này; bật lại sau khi đổi.
- Trong cửa sổ nhỏ của extension, bước vân tay mở ra một cửa sổ riêng (hộp vân tay của máy sẽ làm cửa
  sổ nhỏ tự đóng). Bật tính năng này thì làm trong tab (nút **Bật trong tab**).

### Khoá khôi phục

KaiPass không gửi master password đi đâu, nên quên là không ai lấy lại được, **trừ khi bạn đã tạo
khoá khôi phục**:

1. **Cài đặt → Mở khoá nhanh và khôi phục**: nhập master password hiện tại, bấm **Tạo** ở dòng
   "Khoá khôi phục".
2. KaiPass tự tải về **bộ khôi phục** (`KaiPass-khoi-phuc-….html`): trang có khoá và mã QR của khoá,
   in ra được. Cất file ở nơi khác Google Drive chứa vault (USB, máy khác), hoặc in ra giấy.
3. Khi quên: màn hình khoá → **Quên master password?** → chọn file bộ khôi phục, hoặc ảnh chụp bản in
   (chỉ cần thấy mã QR), hoặc gõ / dán khoá → đặt master password mới. Trên thiết bị mới, mục này có ở
   bước "Đã tìm thấy vault trên Drive".

Cách làm: KaiPass tạo một cặp khoá. Khoá riêng được mã hoá bằng khoá khôi phục; master password
được mã hoá bằng khoá công khai, nên mỗi lần bạn đổi master password nó được mã hoá lại mà không cần
khoá khôi phục. Bản ghi này (đã mã hoá) nằm trên thiết bị và, với vault trên Drive, trong file
`kaipass-recovery.json` cạnh vault. Ai có khoá khôi phục **và** quyền vào Drive (hoặc thiết bị) của
bạn sẽ mở được vault, nên hãy giữ khoá này cẩn thận như master password.

### Xoá dữ liệu trên thiết bị

Nút xoá không còn ở màn hình khoá. Nó nằm trong **Quên master password?** và **Cài đặt → Thiết bị
này**, phải gõ "XOÁ" mới bấm được. Với vault chỉ lưu trên thiết bị, có nút tải bản sao lưu (đã mã hoá)
ngay cạnh, kể cả khi chưa mở khoá.

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
npm run build:android && npm run e2e:android                # giao diện bản Android, phần native giả lập
cd android && ./gradlew testDebugUnitTest                   # phần Kotlin: OTP, nhận diện ô, khớp trang/app
npm run apk        # APK (cần Android SDK; ký bằng KAIPASS_KEYSTORE + KAIPASS_KEYSTORE_PASSWORD)
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
- `src/lib/bio.ts`: mở khoá bằng vân tay / mật khẩu máy (WebAuthn PRF)
- `src/lib/recovery.ts`, `src/lib/recoveryKit.ts`: khoá khôi phục và bộ khôi phục
- `src/lib/qr.ts`: đọc mã QR (OTP, Google Authenticator)
- `src/lib/ai.ts`: tách tin nhắn bằng Claude
- `src/icons/`: các bộ icon, tạo bằng `node scripts/gen-icons.cjs`
- `android/`: app Android (Kotlin): `WebHostActivity.kt` (mở web app, cầu nối native),
  `KaiPassAutofillService.kt` + `Classifier.kt` + `Matcher.kt` (tự điền), `Bio.kt` (vân tay),
  `GoogleAuth.kt` (Drive); phía web là `src/lib/android.ts` và `src/lib/androidIndex.ts`
- `src/ext/`: phần riêng của extension: `background.ts` (service worker), `content.ts` (gợi ý trên
  trang), `fill.ts` (điền vào form)
- `src/ui/`: giao diện
- `extension/manifest.json`: khai báo extension
