import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent, request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { assertSafeAiBaseUrl } from '../llm/ai-config.service';
import { MAX_OUTPUT_TOKENS } from './classification-input';

export type ProviderFailureCode = 'rate_limit' | 'timeout' | 'invalid_response' | 'provider_error' | 'unsafe_url';

export class ProviderFailure extends Error {
  constructor(readonly code: ProviderFailureCode, readonly retryAfterMs?: number) {
    super(code);
    this.name = 'ProviderFailure';
  }
}

type Message = { role: string; content: string };
type ProviderConfig = { baseUrl: string; apiKey: string; model: string };
type Address = { address: string; family: number };
export type ChatTool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean } };

function retryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 86_400_000) : undefined;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function costMicros(usage: Record<string, unknown>): bigint | null {
  const value = usage.cost_usd ?? (usage.currency === 'USD' ? usage.cost : null);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 1_000_000
    ? BigInt(Math.round(value * 1_000_000))
    : null;
}

export async function fetchClassification(
  config: ProviderConfig,
  messages: Message[],
  tools?: ChatTool[],
): Promise<{ content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }>; inputTokens: number | null; outputTokens: number | null; costMicros: bigint | null }> {
  let url: URL;
  let addresses: Address[];
  try {
    url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true });
    await assertSafeAiBaseUrl(config.baseUrl, async () => addresses);
  } catch {
    throw new ProviderFailure('unsafe_url');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const pinned = addresses[0]!;
  const pinnedLookup = ((host: string, options: { all?: boolean }, callback: (error: NodeJS.ErrnoException | null, address: string | Address[], family?: number) => void) => {
    if (host.replace(/^\[|\]$/g, '').toLowerCase() !== hostname) return callback(Object.assign(new Error('DNS host mismatch'), { code: 'ENOTFOUND' }), '', 0);
    if (options?.all) return callback(null, [{ address: pinned.address, family: pinned.family }]);
    return callback(null, pinned.address, pinned.family);
  }) as LookupFunction;
  const agent = new Agent({ keepAlive: false, lookup: pinnedLookup });
  const body = JSON.stringify({ model: config.model, messages, max_tokens: MAX_OUTPUT_TOKENS, ...(tools ? { tools, tool_choice: 'auto' } : {}) });
  const hostHeader = url.host;

  try {
    const data = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      let settled = false;
      const timer: { current?: NodeJS.Timeout } = {};
      const fail = (error: ProviderFailure) => {
        if (settled) return;
        settled = true;
        if (timer.current) clearTimeout(timer.current);
        reject(error);
      };
      const finish = (result: { status: number; headers: IncomingHttpHeaders; body: Buffer }) => {
        if (settled) return;
        settled = true;
        if (timer.current) clearTimeout(timer.current);
        resolve(result);
      };
      const req = httpsRequest(url, {
        method: 'POST',
        agent,
        servername: isIP(hostname) ? undefined : hostname,
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Host: hostHeader },
      }, (res) => {
        if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          fail(new ProviderFailure('provider_error'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > 64 * 1024) {
            req.destroy();
            fail(new ProviderFailure('invalid_response'));
          } else chunks.push(bytes);
        });
        res.on('end', () => finish({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', () => fail(new ProviderFailure('provider_error')));
      });
      let timedOut = false;
      const timeout = () => {
        timedOut = true;
        req.destroy();
        fail(new ProviderFailure('timeout'));
      };
      timer.current = setTimeout(timeout, 20_000);
      req.setTimeout(20_000, timeout);
      req.on('error', () => fail(new ProviderFailure(timedOut ? 'timeout' : 'provider_error')));
      req.end(body);
    });

    if (data.status === 429) throw new ProviderFailure('rate_limit', retryAfter(data.headers['retry-after']));
    if (data.status < 200 || data.status >= 300) throw new ProviderFailure('provider_error');
    let parsed: unknown;
    try { parsed = JSON.parse(data.body.toString('utf8')); } catch { throw new ProviderFailure('invalid_response'); }
    if (!parsed || typeof parsed !== 'object') throw new ProviderFailure('invalid_response');
    const result = parsed as { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }> } }>; usage?: Record<string, unknown> };
    const content = result.choices?.[0]?.message?.content;
    const toolCalls = result.choices?.[0]?.message?.tool_calls?.map((call) => {
      const { id, function: fn } = call;
      return typeof id === 'string' && typeof fn?.name === 'string' && typeof fn.arguments === 'string'
        ? { id, name: fn.name, arguments: fn.arguments } : null;
    });
    if (toolCalls?.some((call) => call === null)) throw new ProviderFailure('invalid_response');
    if ((typeof content !== 'string' || !content.trim()) && !toolCalls?.length) throw new ProviderFailure('invalid_response');
    const usage = result.usage ?? {};
    return {
      content: typeof content === 'string' ? content : '',
      ...(tools ? { toolCalls: toolCalls?.filter((call): call is NonNullable<typeof call> => call !== null) ?? [] } : {}),
      inputTokens: tokenCount(usage.prompt_tokens),
      outputTokens: tokenCount(usage.completion_tokens),
      costMicros: costMicros(usage),
    };
  } finally {
    agent.destroy();
  }
}
