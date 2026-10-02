import { afterEach, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, isEncrypted, secretsKeyConfigured } from './crypto-secrets';

describe('crypto-secrets', () => {
  afterEach(() => { delete process.env.SECRETS_KEY; });

  it('cifra e decifra com SECRETS_KEY; valor cifrado tem prefixo enc:v1:', () => {
    process.env.SECRETS_KEY = 'uma-passphrase-qualquer';
    const c = encryptSecret('segredo');
    expect(isEncrypted(c)).toBe(true);
    expect(c).not.toContain('segredo');
    expect(decryptSecret(c)).toBe('segredo');
  });

  it('sem SECRETS_KEY é passthrough (texto puro) e avisa via secretsKeyConfigured=false', () => {
    expect(secretsKeyConfigured()).toBe(false);
    expect(encryptSecret('x')).toBe('x');
  });

  it('valor adulterado falha sem vazar conteúdo', () => {
    process.env.SECRETS_KEY = 'k';
    const c = encryptSecret('segredo')!;
    const ruim = c.slice(0, -2) + 'AA';
    expect(() => decryptSecret(ruim)).toThrow(/adulterado|SECRETS_KEY/);
  });
});
