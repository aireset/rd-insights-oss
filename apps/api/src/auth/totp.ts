import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const CODE_DIGITS = 6;

function base32Encode(bytes: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/=+$/, '')) {
    const digit = BASE32.indexOf(char);
    if (digit < 0) throw new Error('Invalid TOTP secret');
    value = (value << 5) | digit; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function createTotpSecret(): string { return base32Encode(randomBytes(20)); }

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  const binary = ((digest[offset]! & 127) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
}

export function matchingTotpStep(secret: string, code: string, now = Date.now(), afterStep = -1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const candidate = Buffer.from(code);
  const current = Math.floor(now / 1000 / STEP_SECONDS);
  for (const step of [current + 1, current, current - 1]) {
    if (step <= afterStep) continue;
    if (timingSafeEqual(candidate, Buffer.from(totpCode(secret, step)))) return step;
  }
  return null;
}

export function createRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => randomBytes(16).toString('hex').toUpperCase().match(/.{1,4}/g)!.join('-'));
}

export function normalizeRecoveryCode(code: string): string { return code.replaceAll('-', '').toLowerCase(); }
export function hashRecoveryCode(code: string): string { return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex'); }
