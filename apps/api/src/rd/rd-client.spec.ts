import { describe, expect, it, vi } from 'vitest';
import { RdClient, type RdTokens } from './rd-client';

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function make(tokens: RdTokens, fetchImpl: typeof fetch, rateLimit = vi.fn(async () => {})) {
  const saved: RdTokens[] = [];
  const client = new RdClient({ baseUrl: 'https://rd.test', clientId: 'cid', clientSecret: 'sec', tokens, onTokens: async (t) => { saved.push(t); }, fetchImpl, sleep: async () => {}, rateLimit });
  return { client, saved, rateLimit };
}

describe('RdClient', () => {
  it('reserves budget before each platform attempt and stops before an unbudgeted retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(429, {}));
    const beforeRequest = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('budget exhausted'));
    const client = new RdClient({ baseUrl: 'https://rd.test', clientId: 'cid', clientSecret: 'sec', tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 5 * 3_600_000) }, onTokens: async () => {}, fetchImpl, rateLimit: async () => {}, sleep: async () => {}, beforeRequest });
    await expect(client.get('/platform/contacts/uuid:test')).rejects.toThrow('budget exhausted');
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('renova o access token antes de chamar quando faltar < 1h', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(200, { access_token: 'novo', refresh_token: 'r2', expires_in: 86400 }))
      .mockResolvedValueOnce(res(200, { segmentations: [] }));
    const { client, saved, rateLimit } = make({ accessToken: 'velho', refreshToken: 'r1', expiresAt: new Date(Date.now() + 10 * 60_000) }, fetchImpl);
    await client.get('/platform/segmentations');
    expect(fetchImpl.mock.calls[0]![0]).toContain('/auth/token?token_by=refresh_token');
    expect(saved[0]).toMatchObject({ accessToken: 'novo', refreshToken: 'r2' });
    expect((fetchImpl.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer novo' });
    expect(rateLimit.mock.calls).toEqual([['oauth.refresh'], ['segmentations.list']]);
  });

  it('em 429 espera e repete; em 401 após refresh lança RdProviderError 401', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(429, {}, { 'retry-after': '1' }))
      .mockResolvedValueOnce(res(200, { ok: 1 }));
    const { client } = make({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 5 * 3_600_000) }, fetchImpl);
    expect(await client.get('/x')).toEqual({ ok: 1 });

    const f2 = vi.fn().mockResolvedValueOnce(res(401, {})).mockResolvedValueOnce(res(200, { access_token: 'n', refresh_token: 'r', expires_in: 86400 })).mockResolvedValueOnce(res(401, {}));
    const { client: c2 } = make({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 5 * 3_600_000) }, f2);
    await expect(c2.get('/x')).rejects.toMatchObject({ providerStatus: 401 });
  });

  it('exchangeCode troca o code por tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(200, { access_token: 'a', refresh_token: 'r', expires_in: 86400 }));
    const rateLimit = vi.fn(async () => {});
    const t = await RdClient.exchangeCode({ baseUrl: 'https://rd.test', clientId: 'cid', clientSecret: 'sec', code: 'c0de', rateLimit, fetchImpl });
    expect(t.accessToken).toBe('a');
    expect(rateLimit).toHaveBeenCalledWith('oauth.exchange');
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ client_id: 'cid', client_secret: 'sec', code: 'c0de' });
  });

  it('atualiza assinatura de webhook no endpoint por uuid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { uuid: 'uuid-1' }));
    const { client } = make({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 5 * 3_600_000) }, fetchImpl);
    const body = { event_type: 'WEBHOOK.CONVERTED', url: 'https://app.test/hook' };
    await client.put('/integrations/webhooks/uuid-1', body);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://rd.test/integrations/webhooks/uuid-1');
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: 'PUT', body: JSON.stringify(body) });
  });

  it('timeout de fetch é retentável e esgota em RdProviderError', async () => {
    const timeout = () => Object.assign(new Error('t'), { name: 'TimeoutError' });
    const f1 = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValueOnce(res(200, { ok: 1 }));
    const { client } = make({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 5 * 3_600_000) }, f1);
    expect(await client.get('/x')).toEqual({ ok: 1 });
    expect((f1.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);

    const f2 = vi.fn().mockRejectedValue(timeout());
    const { client: c2 } = make({ accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 5 * 3_600_000) }, f2);
    await expect(c2.get('/x')).rejects.toThrow('RD não respondeu (timeout)');
    expect(f2).toHaveBeenCalledTimes(6);
  });
});

describe('RdClient 429 (limite do RD)', () => {
  const fresh = { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 5 * 3_600_000) };
  it('sem retry-after: 8 tentativas com backoff min(60s, 1s·2^n)+jitter e depois falha', async () => {
    const fetchImpl = vi.fn(async () => res(429, {}));
    const waits: number[] = [];
    const client = new RdClient({ baseUrl: 'https://rd.test', clientId: 'c', clientSecret: 's', tokens: fresh, onTokens: async () => {}, fetchImpl, rateLimit: async () => {}, sleep: async (ms) => { waits.push(ms); } });
    await expect(client.get('/x')).rejects.toMatchObject({ providerStatus: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(9); // 1 + 8 retries
    expect(waits).toHaveLength(8);
    waits.forEach((w, n) => { const base = Math.min(60_000, 1000 * 2 ** n); expect(w).toBeGreaterThanOrEqual(base); expect(w).toBeLessThan(base + 500); });
  });
  it('entrega os headers da resposta ao chamador (total de páginas)', async () => {
    const fetchImpl = vi.fn(async () => res(200, { contacts: [] }, { 'pagination-total-pages': '7' }));
    const client = new RdClient({ baseUrl: 'https://rd.test', clientId: 'c', clientSecret: 's', tokens: fresh, onTokens: async () => {}, fetchImpl, rateLimit: async () => {} });
    let total: string | null = null;
    await client.get('/x', {}, (h) => { total = h.get('pagination-total-pages'); });
    expect(total).toBe('7');
  });
});
