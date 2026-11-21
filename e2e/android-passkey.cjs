// Checks the Android app's passkey answers (written by PasskeyTest.kt during `gradlew
// testDebugUnitTest`) with a real WebAuthn server library, the same one the extension's tests use.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

(async () => {
  const { verifyRegistrationResponse, verifyAuthenticationResponse } = await import('@simplewebauthn/server');
  const a = JSON.parse(readFileSync(join(__dirname, '../android/app/build/passkey-answers.json'), 'utf8'));
  let failed = false;
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `: ${detail}`}`);
    if (!ok) failed = true;
  };
  const reg = await verifyRegistrationResponse({ response: a.registration, expectedChallenge: a.registerChallenge, expectedOrigin: a.origin, expectedRPID: a.rpId, requireUserVerification: true });
  const info = reg.registrationInfo;
  check('Android: passkey mới được máy chủ WebAuthn chấp nhận', reg.verified && info.userVerified && info.credentialBackedUp && info.credentialDeviceType === 'multiDevice', JSON.stringify(info));
  for (const [i, response] of a.assertions.entries()) {
    const got = await verifyAuthenticationResponse({ response, expectedChallenge: a.signInChallenge, expectedOrigin: a.origin, expectedRPID: a.rpId, credential: info.credential, requireUserVerification: true });
    check(`Android: chữ ký đăng nhập được máy chủ xác nhận (${i + 1})`, got.verified);
  }
  const wrong = await verifyAuthenticationResponse({ response: a.assertions[0], expectedChallenge: a.signInChallenge, expectedOrigin: 'https://evil.example', expectedRPID: a.rpId, credential: info.credential }).then((r) => r.verified, () => false);
  check('Android: sai trang thì máy chủ từ chối', wrong === false);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
