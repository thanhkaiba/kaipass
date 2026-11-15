export interface GenOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
}

export const defaultGen: GenOptions = { length: 20, upper: true, lower: true, digits: true, symbols: true };

const SETS = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  digits: '23456789',
  symbols: '!@#$%^&*-_=+?',
};

function randInt(max: number): number {
  // Rejection sampling, so every index is equally likely.
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

export function generatePassword(opts: GenOptions): string {
  const sets = (Object.keys(SETS) as (keyof typeof SETS)[]).filter((k) => opts[k]).map((k) => SETS[k]);
  if (!sets.length) sets.push(SETS.lower);
  const length = Math.max(sets.length, Math.min(128, Math.floor(opts.length) || 20));
  const all = sets.join('');
  const chars: string[] = sets.map((s) => s[randInt(s.length)]);
  while (chars.length < length) chars.push(all[randInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
