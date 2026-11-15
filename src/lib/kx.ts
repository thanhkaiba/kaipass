import * as ns from 'kdbxweb';
import { argon2d, argon2id } from 'hash-wasm';

// kdbxweb ships as a UMD bundle: depending on the loader its API is either the namespace itself
// or its `default` export.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const kdbxweb: typeof ns = (ns as any).Kdbx ? ns : (ns as any).default;

kdbxweb.CryptoEngine.setArgon2Impl(
  async (password, salt, memory, iterations, length, parallelism, type, version) => {
    if (version !== 0x13) throw new Error('Phiên bản Argon2 không được hỗ trợ');
    const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
    const out = await fn({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      memorySize: memory,
      iterations,
      hashLength: length,
      parallelism,
      outputType: 'binary',
    });
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  },
);
