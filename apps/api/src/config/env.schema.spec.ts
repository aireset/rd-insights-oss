import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

const base = { DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test', JWT_ACCESS_SECRET: 'local-fixture-secret' };
describe('reconciliation configuration', () => {
  it('defaults to hourly scheduling and allows explicit disable', () => {
    expect(validateEnv(base)).toMatchObject({ RD_RECONCILIATION_ENABLED: true, RD_RECONCILIATION_INTERVAL_MINUTES: 60 });
    expect(validateEnv({ ...base, RD_RECONCILIATION_ENABLED: 'false' })).toMatchObject({ RD_RECONCILIATION_ENABLED: false });
  });
  it('rejects unbounded or invalid scheduling intervals', () => {
    for (const interval of ['0', '1441', '1.5', 'invalid']) expect(() => validateEnv({ ...base, RD_RECONCILIATION_INTERVAL_MINUTES: interval })).toThrow();
  });
});

describe('SMTP configuration', () => {
  it('permite produção sem SMTP para que o app suba com recuperação desabilitada', () => {
    const config = validateEnv({ ...base, NODE_ENV: 'production', SECRETS_KEY: 'a-test-secret-key', REDIS_URL: 'redis://127.0.0.1:1' });
    expect(config.SMTP_HOST).toBeUndefined();
    expect(config.SMTP_FROM).toBeUndefined();
  });

  it('exige sender e credenciais SMTP em pares quando host é configurado', () => {
    expect(() => validateEnv({ ...base, SMTP_HOST: 'smtp.example.com' })).toThrow('SMTP_FROM');
    expect(() => validateEnv({ ...base, SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'reset@example.com', SMTP_USER: 'user' })).toThrow('SMTP_USER e SMTP_PASS');
    expect(validateEnv({ ...base, SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'reset@example.com', SMTP_USER: 'user', SMTP_PASS: 'pass' }).SMTP_PORT).toBeUndefined();
  });
});
