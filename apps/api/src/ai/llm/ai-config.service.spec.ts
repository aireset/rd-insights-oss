import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_KEY } from '../../auth/auth.decorators';
import { AiConfigController } from './ai-config.controller';
import { AiConfigService, assertSafeAiBaseUrl } from './ai-config.service';
import { decryptSecret, isEncrypted } from '../../common/crypto-secrets';

const prisma = {
  aiConfig: { findUnique: vi.fn(), upsert: vi.fn() },
};

describe('AiConfigService', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('SECRETS_KEY', 'ai-config-test-key'); });
  afterEach(() => vi.unstubAllEnvs());

  it('does not return the API key and scopes the read to the account', async () => {
    prisma.aiConfig.findUnique.mockResolvedValue({ accountId: 'a1', provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'model-1', enabled: true, monthlyBudgetCents: 1000, requestsPerMinute: 5, apiKey: 'secret' });
    const service = new AiConfigService(prisma as never);
    const result = await service.get('a1');
    expect(prisma.aiConfig.findUnique).toHaveBeenCalledWith({ where: { accountId: 'a1' } });
    expect(result).toEqual({ provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'model-1', enabled: true, monthlyBudgetCents: 1000, requestsPerMinute: 5, hasApiKey: true });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('preserves the encrypted key when the password field is blank', async () => {
    prisma.aiConfig.findUnique.mockResolvedValue({ apiKey: 'enc:v1:stored' });
    prisma.aiConfig.upsert.mockImplementation(async (arg) => ({ accountId: 'a1', provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'model-1', enabled: true, monthlyBudgetCents: 1000, requestsPerMinute: 5, apiKey: arg.create.apiKey } as never));
    const service = new AiConfigService(prisma as never, async () => [{ address: '93.184.216.34' }]);
    await service.save('a1', { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'model-1', enabled: true, monthlyBudgetCents: 1000, requestsPerMinute: 5, apiKey: '' });
    const call = prisma.aiConfig.upsert.mock.calls[0]![0] as { where: unknown; create: { apiKey: string }; update: { apiKey?: string } };
    expect(call.where).toEqual({ accountId: 'a1' });
    expect(call.create.apiKey).toBe('enc:v1:stored');
    expect(call.update.apiKey).toBeUndefined();
  });

  it('encrypts a new key before it reaches the database', async () => {
    prisma.aiConfig.findUnique.mockResolvedValue(null);
    prisma.aiConfig.upsert.mockImplementation(async (arg) => ({ accountId: 'a1', ...arg.create } as never));
    const service = new AiConfigService(prisma as never, async () => [{ address: '93.184.216.34' }]);
    await service.save('a1', { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'model-1', enabled: true, monthlyBudgetCents: 1000, requestsPerMinute: 5, apiKey: 'plain-secret' });
    const call = prisma.aiConfig.upsert.mock.calls[0]![0] as { create: { apiKey: string } };
    expect(isEncrypted(call.create.apiKey)).toBe(true);
    expect(decryptSecret(call.create.apiKey)).toBe('plain-secret');
  });

  it('requires HTTPS and rejects private or mixed DNS answers', async () => {
    await expect(assertSafeAiBaseUrl('http://provider.example/v1', async () => [{ address: '93.184.216.34' }])).rejects.toThrow();
    await expect(assertSafeAiBaseUrl('https://provider.example/v1', async () => [{ address: '127.0.0.1' }])).rejects.toThrow();
    await expect(assertSafeAiBaseUrl('https://provider.example/v1', async () => [{ address: '93.184.216.34' }, { address: '10.0.0.2' }])).rejects.toThrow();
    await expect(assertSafeAiBaseUrl('https://provider.example/v1', async () => [{ address: '93.184.216.34' }])).resolves.toBeUndefined();
    await expect(assertSafeAiBaseUrl('https://[2001:2::1]/v1')).rejects.toThrow(/endereço público/);
    await expect(assertSafeAiBaseUrl('https://[2001:4860:4860::8888]/v1')).resolves.toBeUndefined();
  });

  it('rejects a private provider before reading or writing account configuration', async () => {
    const service = new AiConfigService(prisma as never, async () => [{ address: '10.0.0.8' }]);
    await expect(service.save('a1', { provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', model: 'model-1', enabled: true, monthlyBudgetCents: 1000, requestsPerMinute: 5, apiKey: 'key' })).rejects.toThrow(/endereço público/);
    expect(prisma.aiConfig.findUnique).not.toHaveBeenCalled();
    expect(prisma.aiConfig.upsert).not.toHaveBeenCalled();
  });

  it('fails closed when SECRETS_KEY is absent', async () => {
    vi.stubEnv('SECRETS_KEY', '');
    const service = new AiConfigService(prisma as never, async () => [{ address: '93.184.216.34' }]);
    await expect(service.save('a1', { provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', model: 'model-1', enabled: true, monthlyBudgetCents: 1000, requestsPerMinute: 5, apiKey: 'key' })).rejects.toThrow(/SECRETS_KEY/);
    expect(prisma.aiConfig.upsert).not.toHaveBeenCalled();
  });

  it('restricts config mutations to admins', () => {
    expect(Reflect.getMetadata(ADMIN_KEY, AiConfigController)).toBe(true);
  });
});
