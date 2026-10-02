import { describe, expect, it } from 'vitest';
import { createRecoveryCodes, createTotpSecret, hashRecoveryCode, matchingTotpStep, totpCode } from './totp';

describe('optional TOTP primitives', () => {
  it('blocks TOTP replay and hashes normalized recovery codes', () => {
    const secret = createTotpSecret();
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    const code = totpCode(secret, step);
    expect(matchingTotpStep(secret, code, now)).toBe(step);
    expect(matchingTotpStep(secret, code, now, step)).toBeNull();
    const recovery = createRecoveryCodes()[0]!;
    expect(recovery).toMatch(/^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);
    expect(hashRecoveryCode(recovery)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRecoveryCode(recovery)).not.toBe(recovery);
    expect(hashRecoveryCode(recovery)).toBe(hashRecoveryCode(recovery.toLowerCase().replaceAll('-', '')));
  });
});
