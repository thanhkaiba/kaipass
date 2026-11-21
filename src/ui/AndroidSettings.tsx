/** Settings → Tự điền, in the Android app: turning KaiPass on as the phone's autofill service. */
import { useEffect, useState } from 'react';
import { androidInfo, native, onNative, type AndroidInfo } from '../lib/android';
import { Setting } from './Settings';

export function AndroidAutofillSettings() {
  const [info, setInfo] = useState<AndroidInfo | null>(null);
  useEffect(() => {
    const load = () => void androidInfo().then(setInfo).catch(() => {});
    load();
    // Back from Android's settings screen.
    return onNative('resume', load);
  }, []);
  const on = !!info?.autofill.enabled;
  return (
    <>
      <div className="group">
        <Setting
          icon="key"
          on={on}
          title="Dịch vụ tự điền"
          info="KaiPass điền mật khẩu và mã OTP vào app và trang web, và hỏi lưu khi bạn đăng nhập tài khoản mới."
          sub={info && !info.autofill.supported ? 'Máy này không hỗ trợ' : on ? 'KaiPass đang tự điền' : 'Chưa bật'}
        >
          <button type="button" className={on ? '' : 'primary'} onClick={() => void native('openAutofillSettings')}>
            {on ? 'Đổi' : 'Bật'}
          </button>
        </Setting>
        {info?.passkeys?.supported && (
          <Setting
            icon="finger"
            on={info.passkeys.enabled}
            title="Passkey"
            info="KaiPass lưu và dùng passkey trong app, trình duyệt, và khi bạn quét mã QR để đăng nhập trên máy khác."
            sub={info.passkeys.enabled ? 'KaiPass đang giữ passkey' : 'Chưa bật trong cài đặt của máy'}
          >
            <button type="button" className={info.passkeys.enabled ? '' : 'primary'} onClick={() => void native('openPasskeySettings')}>
              {info.passkeys.enabled ? 'Đổi' : 'Bật'}
            </button>
          </Setting>
        )}
      </div>
      <ul className="help-list">
        <li>
          <strong>Trong app:</strong> chạm vào ô đăng nhập rồi chọn tài khoản KaiPass (trên bàn phím hoặc danh sách hiện ra).
          Không thấy tài khoản thì chọn <em>Tìm trong KaiPass…</em>. KaiPass sẽ nhớ lựa chọn đó cho app này.
        </li>
        <li>
          <strong>Chrome:</strong> Cài đặt → Dịch vụ tự động điền → <em>Tự động điền bằng dịch vụ khác</em>. Firefox, Brave,
          Edge, Cốc Cốc và Samsung Internet dùng được luôn.
        </li>
        <li>
          <strong>Mã OTP:</strong> ô OTP được điền mã mới nhất. Nếu trang hỏi OTP ở bước sau, mã đã được chép sẵn, chỉ cần dán.
        </li>
        {info?.passkeys?.supported && (
          <li>
            <strong>Passkey:</strong> khi app hoặc trang đề nghị tạo hay dùng passkey, chọn <em>KaiPass</em> trên bảng của
            Android rồi chạm vân tay. Đăng nhập trên máy tính khác: chọn "dùng điện thoại", quét mã QR bằng camera, rồi chọn
            passkey trong KaiPass.
          </li>
        )}
        <li>
          <strong>Khi vault đang khoá:</strong> chạm <em>Mở khoá KaiPass</em>, mở bằng vân tay, rồi chọn tài khoản.
        </li>
      </ul>
      {info && (
        <div className="muted small app-id">
          <div>KaiPass cho Android {info.version}</div>
          {/* What the Android OAuth client in Google Cloud must match for Drive sign-in. */}
          <div>
            Package: <span className="mono">{info.package}</span>
          </div>
          <div>
            SHA-1: <span className="mono">{info.sha1}</span>
          </div>
        </div>
      )}
    </>
  );
}
