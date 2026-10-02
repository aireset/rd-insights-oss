import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ Agent: class Agent { constructor(readonly options: unknown) {} destroy() {} }, request: mocks.request }));

import { fetchClassification } from './provider-fetch';

const config = { baseUrl: 'https://api.example.test/v1', apiKey: 'test-key', model: 'test-model' };
const messages = [{ role: 'user', content: 'hello' }];

function response(body: unknown, statusCode = 200) {
  mocks.request.mockImplementation((_url, _options, onResponse) => {
    const request = new EventEmitter() as EventEmitter & { setTimeout: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    request.setTimeout = vi.fn();
    request.destroy = vi.fn();
    request.end = vi.fn(() => {
      const result = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; resume: ReturnType<typeof vi.fn> };
      result.statusCode = statusCode;
      result.headers = {};
      result.resume = vi.fn();
      queueMicrotask(() => {
        onResponse(result);
        result.emit('data', Buffer.from(JSON.stringify(body)));
        result.emit('end');
      });
    });
    return request;
  });
}

describe('fetchClassification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    response({ choices: [{ message: { content: '{"score":"morno"}' } }], usage: { prompt_tokens: 8, completion_tokens: 3, cost_usd: 0.0002 } });
  });

  it('pins the validated public address while retaining the provider host and TLS name', async () => {
    const result = await fetchClassification(config, messages);
    expect(result).toEqual({ content: '{"score":"morno"}', inputTokens: 8, outputTokens: 3, costMicros: 200n });
    const [url, options] = mocks.request.mock.calls[0]!;
    expect(url.href).toBe('https://api.example.test/v1/chat/completions');
    expect(options.servername).toBe('api.example.test');
    expect(options.headers.Host).toBe('api.example.test');
    const pinnedLookup = options.agent.options.lookup;
    await new Promise<void>((resolve, reject) => pinnedLookup('api.example.test', { all: true }, (error: Error | null, addresses: unknown) => {
      if (error) reject(error);
      else { expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]); resolve(); }
    }));
  });

  it('rejects any private address in the DNS answer set', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(fetchClassification(config, messages)).rejects.toMatchObject({ code: 'unsafe_url' });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('resolves and validates DNS again for every request to stop rebinding', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await fetchClassification(config, messages);
    await expect(fetchClassification(config, messages)).rejects.toMatchObject({ code: 'unsafe_url' });
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('rejects redirects', async () => {
    response({}, 302);
    await expect(fetchClassification(config, messages)).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('enforces the total request timeout', async () => {
    response({});
    mocks.request.mockImplementation((_url, _options, _onResponse) => {
      const request = new EventEmitter() as EventEmitter & { setTimeout: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
      request.setTimeout = vi.fn((_milliseconds: number, onTimeout: () => void) => onTimeout());
      request.end = vi.fn();
      request.destroy = vi.fn();
      return request;
    });
    await expect(fetchClassification(config, messages)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects responses above the size limit', async () => {
    response('x'.repeat(65 * 1024));
    await expect(fetchClassification(config, messages)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
