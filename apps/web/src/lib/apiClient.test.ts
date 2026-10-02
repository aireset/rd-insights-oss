import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './apiClient';

describe('api text responses', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns CSV response bodies as text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('"Nome";"E-mail"\r\n"Ana";"ana@example.com"', { headers: { 'content-type': 'text/csv; charset=utf-8' } })));

    await expect(api.get<string>('/leads/export.csv')).resolves.toContain('ana@example.com');
  });

  it('returns authenticated downloads without consuming their body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('csv', { headers: { 'content-type': 'text/csv' } })));

    const response = await api.stream('/leads/export.csv');

    expect(response.bodyUsed).toBe(false);
  });
});
