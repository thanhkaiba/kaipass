import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { generatePassword } from './generator';
import { importOnePux } from './onepux';
import { normalizeOtp, parseOtp, totp } from './totp';
import { open as openShare, parseLink, seal, SharePassphraseError, b64url } from './share';
import { createRecord, normalizeKey, recoverPassword, withNewPassword, WrongRecoveryKey } from './recovery';
import { matchScore } from '../ext/match';
import * as brandData from '../icons/brands';
import { brandFor, faviconUrls, inkOn, parseOverrides, resolveOverride } from './brandMatch';
import { otpFromQrText } from './qr';
import { buildKit, extractKey } from './recoveryKit';
import { b64url as pk64, createPasskey, rpIdAllowed, signWithPasskey, unb64url } from './passkey';
import { Vault, WrongPasswordError } from './vault';

const draft = (over: Partial<Parameters<Vault['upsert']>[0]> = {}) => ({
  type: 'login' as const,
  title: 'GitHub',
  username: 'me',
  password: 'hunter2',
  url: 'https://github.com',
  notes: '',
  otp: '',
  fields: [],
  tags: [],
  favorite: false,
  folderId: '',
  ...over,
});

describe('totp', () => {
  // RFC 6238 test vectors (SHA-1, 8 digits, secret "12345678901234567890").
  const uri = 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8';
  it('matches RFC 6238 vectors', async () => {
    expect(await totp(parseOtp(uri), 59_000)).toBe('94287082');
    expect(await totp(parseOtp(uri), 1111111109_000)).toBe('07081804');
    expect(await totp(parseOtp(uri), 20000000000_000)).toBe('65353130');
  });
  it('accepts a bare secret and rejects junk', async () => {
    expect(await totp(parseOtp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), 59_000)).toBe('287082');
    expect(normalizeOtp('GEZDGNBVGY3TQOJQ', 'A B')).toBe(
      'otpauth://totp/A%20B?secret=GEZDGNBVGY3TQOJQ&period=30&digits=6',
    );
    expect(() => parseOtp('not base32 !!')).toThrow();
  });
});

describe('generator', () => {
  it('honours length and character classes', () => {
    const p = generatePassword({ length: 32, upper: true, lower: true, digits: true, symbols: false });
    expect(p).toHaveLength(32);
    expect(p).toMatch(/[A-Z]/);
    expect(p).toMatch(/[a-z]/);
    expect(p).toMatch(/[0-9]/);
    expect(p).not.toMatch(/[^A-Za-z0-9]/);
  });
});

describe('vault', () => {
  it('round-trips items through encryption', async () => {
    const v = await Vault.create('correct horse');
    const folder = v.createFolder('Work');
    const id = v.upsert(
      draft({
        type: 'card',
        favorite: true,
        folderId: folder,
        tags: ['bank'],
        otp: 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ',
        fields: [
          { name: 'CVV', value: '123', secret: true },
          { name: 'Hết hạn', value: '12/2030', secret: false },
        ],
      }),
    );
    await v.addAttachment(id, 'cccd.jpg', new Uint8Array([1, 2, 3]).buffer);
    const bytes = await v.save();

    await expect(Vault.open(bytes, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError);
    const again = await Vault.open(bytes, 'correct horse');
    const item = again.item(id)!;
    expect(item).toMatchObject({
      type: 'card',
      title: 'GitHub',
      password: 'hunter2',
      favorite: true,
      folderName: 'Work',
      tags: ['bank'],
      otp: 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ',
      trashed: false,
    });
    expect(item.fields).toEqual([
      { name: 'CVV', value: '123', secret: true },
      { name: 'Hết hạn', value: '12/2030', secret: false },
    ]);
    expect(item.attachments).toEqual([{ name: 'cccd.jpg', size: 3 }]);
    expect([...again.attachment(id, 'cccd.jpg')!]).toEqual([1, 2, 3]);
  });

  it('bins, restores and purges', async () => {
    const v = await Vault.create('pw');
    const id = v.upsert(draft());
    v.remove(id);
    expect(v.item(id)!.trashed).toBe(true);
    v.restore(id);
    expect(v.item(id)!.trashed).toBe(false);
    v.remove(id);
    v.remove(id);
    expect(v.item(id)).toBeUndefined();
  });

  it('merges changes made on two devices', async () => {
    const base = await Vault.create('pw');
    const shared = base.upsert(draft({ title: 'Shared' }));
    const bytes = await base.save();

    const a = await Vault.open(bytes, 'pw');
    const b = await Vault.open(bytes.slice(0), 'pw');
    a.upsert(draft({ title: 'From A' }));
    await new Promise((r) => setTimeout(r, 1100)); // KDBX timestamps have 1 s resolution
    b.upsert(draft({ title: 'From B' }));
    b.upsert({ ...b.item(shared)!, password: 'changed-on-b' });

    await a.merge(await b.save());
    const titles = a.items().map((i) => i.title).sort();
    expect(titles).toEqual(['From A', 'From B', 'Shared']);
    expect(a.item(shared)!.password).toBe('changed-on-b');
  });

  it('changes the master password', async () => {
    const v = await Vault.create('old');
    await v.changePassword('new');
    expect(await v.checkPassword('new')).toBe(true);
    expect(await v.checkPassword('old')).toBe(false);
    const bytes = await v.save();
    await expect(Vault.open(bytes, 'old')).rejects.toBeInstanceOf(WrongPasswordError);
    await Vault.open(bytes, 'new');
  });
});

describe('1pux import', () => {
  it('maps logins, cards, OTP, extra fields and files', async () => {
    const data = {
      accounts: [
        {
          vaults: [
            {
              attrs: { name: 'Personal' },
              items: [
                {
                  uuid: 'a',
                  favIndex: 1,
                  state: 'active',
                  categoryUuid: '001',
                  overview: {
                    title: 'Example',
                    url: 'https://example.com',
                    urls: [{ url: 'https://example.com' }, { url: 'https://alt.example.com' }],
                    tags: ['work'],
                  },
                  details: {
                    loginFields: [
                      { designation: 'username', value: 'alice' },
                      { designation: 'password', value: 's3cret' },
                    ],
                    notesPlain: 'hello',
                    sections: [
                      {
                        title: 'Security',
                        fields: [
                          { title: 'one-time password', value: { totp: 'GEZDGNBVGY3TQOJQ' } },
                          { title: 'recovery key', value: { concealed: 'AAAA-BBBB' } },
                          { title: 'scan', value: { file: { documentId: 'doc1', fileName: 'scan.txt' } } },
                        ],
                      },
                    ],
                  },
                },
                {
                  uuid: 'b',
                  state: 'archived',
                  categoryUuid: '002',
                  overview: { title: 'Visa' },
                  details: {
                    sections: [
                      {
                        title: '',
                        fields: [
                          { title: 'number', value: { creditCardNumber: '4111111111111111' } },
                          { title: 'expiry date', value: { monthYear: 203012 } },
                          { title: 'valid from', value: { date: 1704067200 } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const zip = zipSync({
      'export.data': strToU8(JSON.stringify(data)),
      'files/doc1__scan.txt': strToU8('file body'),
    });
    const v = await Vault.create('pw');
    const res = await importOnePux(v, zip);
    expect(res).toEqual({ items: 2, attachments: 1, skipped: [] });

    const login = v.items().find((i) => i.title === 'Example')!;
    expect(login).toMatchObject({
      type: 'login',
      username: 'alice',
      password: 's3cret',
      url: 'https://example.com',
      notes: 'hello',
      favorite: true,
      tags: ['work'],
      folderName: '',
    });
    expect(login.otp).toContain('secret=GEZDGNBVGY3TQOJQ');
    expect(login.fields).toEqual([
      { name: 'KP2A_URL_1', value: 'https://alt.example.com', secret: false },
      { name: 'Security: recovery key', value: 'AAAA-BBBB', secret: true },
    ]);
    expect(new TextDecoder().decode(v.attachment(login.id, 'scan.txt'))).toBe('file body');

    const card = v.items().find((i) => i.title === 'Visa')!;
    expect(card).toMatchObject({ type: 'card', folderName: 'Archive' });
    expect(card.fields).toEqual([
      { name: 'number', value: '4111111111111111', secret: true },
      { name: 'expiry date', value: '12/2030', secret: false },
      { name: 'valid from', value: '2024-01-01', secret: false },
    ]);
  });

  it('rejects files that are not 1pux', async () => {
    const v = await Vault.create('pw');
    await expect(importOnePux(v, strToU8('nope'))).rejects.toThrow();
  });
});

describe('share links', () => {
  const item = {
    type: 'login' as const,
    title: 'AWS',
    username: 'theo',
    password: 'p@ss',
    url: 'https://aws.amazon.com',
    notes: '',
    otp: 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ',
    fields: [],
  };

  it('round-trips, with and without a passphrase', async () => {
    const exp = Date.now() + 3600_000;
    const a = await seal(item, exp);
    expect(await openShare(a.envelope, a.secret)).toEqual(item);
    const b = await seal(item, exp, 'mèo con');
    expect(b.envelope.salt).toBeTruthy();
    await expect(openShare(b.envelope, b.secret, 'sai')).rejects.toBeInstanceOf(SharePassphraseError);
    expect(await openShare(b.envelope, b.secret, 'mèo con')).toEqual(item);
  });

  it('rejects an edited expiry date or a wrong key', async () => {
    const { envelope, secret } = await seal(item, Date.now() + 1000);
    await expect(openShare({ ...envelope, expires: envelope.expires + 86_400_000 }, secret)).rejects.toThrow();
    await expect(openShare(envelope, new Uint8Array(32))).rejects.toThrow();
  });

  it('parses both kinds of link', () => {
    const key = b64url(new Uint8Array(32).fill(7));
    expect(parseLink(`https://x.github.io/kaipass/#share=d.1AbC_d-9.${key}`)).toMatchObject({ kind: 'drive', ref: '1AbC_d-9' });
    expect(parseLink(`https://x/#share=l.eyJ2Ijox.${key}`)).toMatchObject({ kind: 'inline', ref: 'eyJ2Ijox' });
    expect(parseLink('https://x/#share=d.abc.short')).toBeUndefined();
    expect(parseLink('https://example.com/')).toBeUndefined();
  });
});

describe('recovery key', () => {
  it('recovers the master password, also after it changes', async () => {
    const { record, recoveryKey } = await createRecord('old master');
    expect(recoveryKey).toMatch(/^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/);
    expect(await recoverPassword(record, recoveryKey)).toBe('old master');
    // Typed in lower case, without dashes, with spaces: still accepted.
    expect(await recoverPassword(record, recoveryKey.toLowerCase().replace(/-/g, ' '))).toBe('old master');
    const changed = await withNewPassword(record, 'new master');
    expect(await recoverPassword(changed, recoveryKey)).toBe('new master');
    expect(JSON.stringify(changed)).not.toContain('master');
  });

  it('rejects a wrong recovery key', async () => {
    const { record } = await createRecord('pw');
    await expect(recoverPassword(record, 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF')).rejects.toBeInstanceOf(WrongRecoveryKey);
    expect(normalizeKey('ab-cd ef')).toBe('ABCDEF');
  });
});

describe('address matching', () => {
  const page = 'us-east-1.signin.aws.amazon.com';
  it('offers logins from the same site, closest first', () => {
    const exact = matchScore(page, page);
    const otherRegion = matchScore('ap-southeast-2.signin.aws.amazon.com', page);
    const account = matchScore('631670122302.signin.aws.amazon.com', page);
    const console = matchScore('console.aws.amazon.com', page);
    const parent = matchScore('amazon.com', page);
    expect(exact).toBeGreaterThan(otherRegion);
    expect(account).toBe(otherRegion);
    expect(otherRegion).toBeGreaterThan(console);
    expect(console).toBeGreaterThan(parent);
    expect(parent).toBeGreaterThan(0);
    // A login saved for a parent domain is still offered on its subdomains.
    expect(matchScore('google.com', 'accounts.google.com')).toBeGreaterThan(0);
  });

  it('never crosses sites', () => {
    expect(matchScore('amazon.com', 'amazon.com.evil.net')).toBe(0);
    expect(matchScore('alice.github.io', 'evil.github.io')).toBe(0);
    expect(matchScore('vietcombank.com.vn', 'other.com.vn')).toBe(0);
    expect(matchScore('localhost', '127.0.0.1')).toBe(0);
    expect(matchScore('a.localhost', 'b.localhost')).toBe(0);
    expect(matchScore('', page)).toBe(0);
  });
});

/** Builds a Google Authenticator export payload (protobuf) for the tests. */
export function migrationUri(entries: { secret: number[]; name: string; issuer: string; type?: number }[]): string {
  const varint = (n: number) => {
    const out: number[] = [];
    while (n > 127) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n);
    return out;
  };
  const bytes = (field: number, b: number[]) => [...varint(field * 8 + 2), ...varint(b.length), ...b];
  const num = (field: number, n: number) => [...varint(field * 8), ...varint(n)];
  const text = (s: string) => [...new TextEncoder().encode(s)];
  const payload = entries.flatMap((e) =>
    bytes(1, [...bytes(1, e.secret), ...bytes(2, text(e.name)), ...bytes(3, text(e.issuer)), ...num(4, 1), ...num(5, 1), ...num(6, e.type ?? 2)]),
  );
  return `otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...payload, ...num(2, 1))))}`;
}

describe('OTP QR codes', () => {
  it('reads a standard otpauth code with issuer and account', () => {
    const r = otpFromQrText('otpauth://totp/GitHub:theo%40example.com?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub');
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0]).toMatchObject({ issuer: 'GitHub', account: 'theo@example.com' });
  });

  it('reads Google Authenticator exports and skips counter-based codes', async () => {
    const secret = [...new TextEncoder().encode('12345678901234567890')];
    const uri = migrationUri([
      { secret, name: 'theo@example.com', issuer: 'AWS' },
      { secret, name: 'Shopee:theo.shop', issuer: 'Shopee' },
      { secret, name: 'old', issuer: 'Bank', type: 1 },
    ]);
    const r = otpFromQrText(uri);
    expect(r.skipped).toBe(1);
    expect(r.accounts.map((a) => [a.issuer, a.account])).toEqual([
      ['AWS', 'theo@example.com'],
      ['Shopee', 'theo.shop'],
    ]);
    // The secret survives the round trip: same codes as the RFC 6238 test vector.
    const { parseOtp, totp } = await import('./totp');
    expect(await totp(parseOtp(r.accounts[0].uri), 59_000)).toBe('287082');
  });

  it('explains codes that are not two-factor codes', () => {
    expect(() => otpFromQrText('https://example.com')).toThrow(/không phải/);
    expect(() => otpFromQrText('otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ&counter=1')).toThrow(/HOTP/);
  });
});

describe('recovery kit', () => {
  const key = 'ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2-34567';
  it('finds the key in the kit, in pasted text and in compact form', async () => {
    const kit = await buildKit(key);
    expect(kit).toContain(key);
    expect(extractKey(kit)).toBe(key);
    expect(extractKey(`Khoá khôi phục KaiPass\n\n${key}\n`)).toBe(key);
    expect(extractKey('kaipass-recovery:' + key)).toBe(key);
    expect(extractKey(key.toLowerCase().replace(/-/g, ' '))).toBe(key);
    expect(extractKey('nothing here')).toBeUndefined();
  });
});

describe('site logos', () => {
  const id = (title: string, url: string) => brandFor(brandData, title, url)?.id ?? null;

  it('picks the most specific service of a host', () => {
    expect(id('x', 'https://mail.google.com/mail/u/0')).toBe('gmail');
    expect(id('x', 'accounts.google.com')).toBe('google');
    expect(id('x', 'https://drive.google.com')).toBe('googledrive');
    expect(id('x', 'https://foo.atlassian.net/jira')).toBe('jira');
    expect(id('x', 'https://signin.aws.amazon.com/')).toBe('aws');
  });

  it('knows a site under any country suffix', () => {
    expect(id('x', 'https://www.google.com.vn')).toBe('google');
    expect(id('x', 'shopee.vn')).toBe('shopee');
    expect(id('x', 'https://shopee.co.id/login')).toBe('shopee');
    expect(id('x', 'https://www.amazon.co.jp')).toBe('amazon');
    expect(id('x', 'https://github.com/login')).toBe('github');
    expect(id('x', 'https://bitbucket.org')).toBe('bitbucket');
    expect(id('x', 'https://linear.app/team')).toBe('linear');
    expect(id('x', 'https://appleid.apple.com')).toBe('apple');
  });

  it("does not give a platform's logo to the user's own site hosted on it", () => {
    expect(id('Blog', 'https://me.github.io')).toBeNull();
    expect(id('App', 'https://my-app.vercel.app')).toBeNull();
    expect(id('Shop', 'https://notshopee.vn')).toBeNull();
  });

  it('falls back to the title, but not for everyday words', () => {
    expect(id('GitHub - theo', '')).toBe('github');
    expect(id('Vietcombank', '')).toBe('vietcombank');
    expect(id('Google (công việc)', 'https://sso.mycompany.com')).toBe('google');
    expect(id('Visa VCB', '')).toBe('vietcombank');
    expect(id('Tài khoản Google công ty', '')).toBe('google');
    expect(id('Notion', '')).toBe('notion');
    expect(id('FB cá nhân', '')).toBe('facebook');
    expect(id('Gói cước 4G 30 MB', '')).toBeNull();
    expect(id('Line', '')).toBeNull();
    expect(id('Signal', '')).toBeNull();
    expect(id('Wifi nhà', '')).toBeNull();
    expect(id('GitHub', 'androidapp://com.github.android')).toBe('github');
  });

  it('has a letter instead of a logo for brands Simple Icons does not carry', () => {
    const b = brandFor(brandData, 'x', 'https://www.linkedin.com')!;
    expect(b.path).toBe('');
    expect(b.letter).toBe('in');
  });

  it('chooses readable ink and website icon addresses', () => {
    expect(inkOn('FFFFFF')).toBe('#111');
    expect(inkOn('181717')).toBe('#fff');
    expect(faviconUrls('https://a.example.co.uk/x', 'off')).toEqual([]);
    expect(faviconUrls('https://a.example.co.uk/x', 'site')).toEqual([
      'https://a.example.co.uk/apple-touch-icon.png',
      'https://a.example.co.uk/favicon.ico',
      'https://example.co.uk/apple-touch-icon.png',
      'https://example.co.uk/favicon.ico',
    ]);
    expect(faviconUrls('example.com', 'ddg')).toEqual(['https://icons.duckduckgo.com/ip3/example.com.ico']);
    expect(faviconUrls('androidapp://com.x', 'site')).toEqual([]);
  });

  it('reads logos the user accepted from Claude, ignoring bad ones', () => {
    expect(parseOverrides('not json')).toEqual({});
    expect(parseOverrides('[1]')).toEqual({});
    expect(resolveOverride(brandData, { b: 'github' })?.title).toBe('GitHub');
    expect(resolveOverride(brandData, { t: 'Viettel Money', h: 'ee0033', l: 'VM' })).toMatchObject({ id: 'custom', hex: 'EE0033', letter: 'VM' });
    expect(resolveOverride(brandData, { b: 'nope' })).toBeNull();
    expect(resolveOverride(brandData, { t: 'X', h: 'red', l: 'X' })).toBeNull();
    expect(resolveOverride(brandData, undefined)).toBeNull();
  });
});

describe('passkeys', () => {
  const origin = 'https://login.example.com';
  const rpId = 'example.com';
  const challenge = () => pk64(crypto.getRandomValues(new Uint8Array(32)));

  it('registers and signs in against a real WebAuthn server library', async () => {
    const registerChallenge = challenge();
    const made = await createPasskey({ rpId, origin, challenge: registerChallenge, user: { id: pk64(new TextEncoder().encode('user-42')), name: 'theo@example.com' } });
    const reg = await verifyRegistrationResponse({
      response: {
        id: made.passkey.credentialId,
        rawId: made.passkey.credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: { clientDataJSON: made.response.clientDataJSON, attestationObject: made.response.attestationObject },
      },
      expectedChallenge: registerChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
    expect(reg.verified).toBe(true);
    const cred = reg.registrationInfo!.credential;
    expect(cred.id).toBe(made.passkey.credentialId);
    expect(reg.registrationInfo!.credentialBackedUp).toBe(true);
    expect(made.passkey.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);

    const signChallenge = challenge();
    const a = await signWithPasskey(made.passkey, { origin, challenge: signChallenge });
    const auth = await verifyAuthenticationResponse({
      response: {
        id: made.passkey.credentialId,
        rawId: made.passkey.credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature, userHandle: a.userHandle },
      },
      expectedChallenge: signChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: cred,
      requireUserVerification: true,
    });
    expect(auth.verified).toBe(true);
    expect(new TextDecoder().decode(unb64url(a.userHandle))).toBe('user-42');

    // The same passkey does not sign for another origin's challenge check.
    const wrong = await signWithPasskey(made.passkey, { origin: 'https://evil.example.net', challenge: signChallenge });
    await expect(
      verifyAuthenticationResponse({
        response: { id: made.passkey.credentialId, rawId: made.passkey.credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: wrong.clientDataJSON, authenticatorData: wrong.authenticatorData, signature: wrong.signature } },
        expectedChallenge: signChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: cred,
      }),
    ).rejects.toThrow();
  });

  it('signs correctly many times over (DER encoding of every signature shape)', async () => {
    const made = await createPasskey({ rpId, origin, challenge: challenge(), user: { id: 'dQ', name: 'u' } });
    const reg = await verifyRegistrationResponse({
      response: { id: made.passkey.credentialId, rawId: made.passkey.credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: made.response.clientDataJSON, attestationObject: made.response.attestationObject } },
      expectedChallenge: (c: string) => c.length > 0,
      expectedOrigin: origin,
      expectedRPID: rpId,
    });
    for (let i = 0; i < 40; i++) {
      const c = challenge();
      const a = await signWithPasskey(made.passkey, { origin, challenge: c });
      const ok = await verifyAuthenticationResponse({
        response: { id: made.passkey.credentialId, rawId: made.passkey.credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } },
        expectedChallenge: c,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: reg.registrationInfo!.credential,
      });
      expect(ok.verified).toBe(true);
    }
  });

  it('keeps a passkey on the vault item, out of the custom fields, across saving and reopening', async () => {
    const made = await createPasskey({ rpId, origin, challenge: challenge(), user: { id: 'dXNlcg', name: 'theo@example.com' } });
    const v = await Vault.create('correct horse battery');
    const id = v.upsert({ type: 'login', title: 'Example', username: 'theo@example.com', password: 'pw', url: origin, notes: '', otp: '', fields: [{ name: 'PIN', value: '1234', secret: true }], tags: [], favorite: false, folderId: '', passkey: made.passkey });
    const again = await Vault.open(await v.save(), 'correct horse battery');
    const item = again.item(id)!;
    expect(item.passkey).toEqual(made.passkey);
    expect(item.fields.map((f) => f.name)).toEqual(['PIN']);
    // Editing something else keeps it; clearing it removes it.
    again.upsert({ ...item, password: 'pw2' });
    expect(again.item(id)!.passkey?.credentialId).toBe(made.passkey.credentialId);
    again.upsert({ ...again.item(id)!, passkey: undefined });
    expect(again.item(id)!.passkey).toBeUndefined();
  });

  it('only lets a page use passkeys of its own site', () => {
    expect(rpIdAllowed('example.com', 'login.example.com')).toBe(true);
    expect(rpIdAllowed('login.example.com', 'login.example.com')).toBe(true);
    expect(rpIdAllowed('example.com', 'example.com.evil.net')).toBe(false);
    expect(rpIdAllowed('example.com', 'notexample.com')).toBe(false);
    expect(rpIdAllowed('com', 'example.com')).toBe(false);
    expect(rpIdAllowed('co.uk', 'shop.co.uk')).toBe(false);
    expect(rpIdAllowed('github.io', 'me.github.io')).toBe(false);
    expect(rpIdAllowed('localhost', 'localhost')).toBe(true);
    expect(rpIdAllowed('accounts.example.com', 'example.com')).toBe(false);
  });
});

