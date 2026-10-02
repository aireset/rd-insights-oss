import { RdProviderError } from '../common/errors';

export interface RdTokens { accessToken: string; refreshToken: string; expiresAt: Date }
export interface RdClientOpts {
  baseUrl: string; clientId: string; clientSecret: string; tokens: RdTokens;
  onTokens: (t: RdTokens) => Promise<void>;
  rateLimit: (endpoint: string) => Promise<void>;
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>;
  beforeRequest?: () => Promise<void>;
}
interface TokenBody { access_token: string; refresh_token: string; expires_in: number }

const ONE_HOUR = 3_600_000;
const MAX_RETRIES = 8; // 429
const MAX_RETRIES_TIMEOUT = 5;
const TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_S = 120;

/** min(60s, 1s·2^n) + jitter 0–500 ms (evita as chamadas paralelas voltarem juntas). */
export const backoffMs = (attempt: number): number => Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);

/**
 * Cliente HTTP do RD Station Marketing: Bearer + refresh automático (token vive
 * 24 h; renova quando faltar < 1 h) + backoff em 429 (min(60s, 1s·2^n) + jitter 0–500 ms, 8x).
 * 401 depois de um refresh forçado → RdProviderError(401) → quem chama marca a
 * conexão como `reauth_required`.
 */
export class RdClient {
  private tokens: RdTokens;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: RdClientOpts) {
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static authorizeUrl(baseUrl: string, clientId: string, redirectUri: string, state: string): string {
    const u = new URL('/auth/dialog', baseUrl);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    return u.toString();
  }

  static async exchangeCode(p: { baseUrl: string; clientId: string; clientSecret: string; code: string; rateLimit: (endpoint: string) => Promise<void>; fetchImpl?: typeof fetch }): Promise<RdTokens> {
    await p.rateLimit('oauth.exchange');
    return RdClient.token(p.baseUrl, 'code', { client_id: p.clientId, client_secret: p.clientSecret, code: p.code }, p.fetchImpl ?? fetch);
  }

  private static async token(baseUrl: string, by: 'code' | 'refresh_token', body: Record<string, string>, f: typeof fetch): Promise<RdTokens> {
    const r = await f(`${baseUrl}/auth/token?token_by=${by}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new RdProviderError(`RD recusou o token (${r.status})`, r.status);
    const t = (await r.json()) as TokenBody;
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(Date.now() + t.expires_in * 1000) };
  }

  private async refresh(): Promise<void> {
    await this.opts.rateLimit('oauth.refresh');
    this.tokens = await RdClient.token(this.opts.baseUrl, 'refresh_token', { client_id: this.opts.clientId, client_secret: this.opts.clientSecret, refresh_token: this.tokens.refreshToken }, this.fetchImpl);
    await this.opts.onTokens(this.tokens);
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}, onHeaders?: (h: Headers) => void): Promise<T> {
    const u = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return this.request<T>(u.toString(), { method: 'GET' }, false, 0, onHeaders);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(new URL(path, this.opts.baseUrl).toString(), { method: 'POST', body: JSON.stringify(body) });
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(new URL(path, this.opts.baseUrl).toString(), { method: 'PUT', body: JSON.stringify(body) });
  }

  private async request<T>(url: string, init: RequestInit, refreshed = false, attempt = 0, onHeaders?: (h: Headers) => void): Promise<T> {
    if (this.tokens.expiresAt.getTime() - Date.now() < ONE_HOUR && !refreshed) { await this.refresh(); refreshed = true; }
    await this.opts.rateLimit(endpointKey(new URL(url)));
    await this.opts.beforeRequest?.();
    let r: Response;
    try {
      r = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.tokens.accessToken}`, ...(init.headers ?? {}) } });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name !== 'TimeoutError' && name !== 'AbortError') throw e;
      if (attempt >= MAX_RETRIES_TIMEOUT) throw new RdProviderError('RD não respondeu (timeout)', 504);
      await this.sleep(backoffMs(attempt));
      return this.request<T>(url, init, refreshed, attempt + 1, onHeaders);
    }
    if (r.status === 401 && !refreshed) { await this.refresh(); return this.request<T>(url, init, true, attempt, onHeaders); }
    if (r.status === 429 && attempt < MAX_RETRIES) {
      const ra = Number(r.headers.get('retry-after'));
      await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, MAX_RETRY_AFTER_S) * 1000 : backoffMs(attempt));
      return this.request<T>(url, init, refreshed, attempt + 1, onHeaders);
    }
    if (!r.ok) throw new RdProviderError(`RD respondeu ${r.status}`, r.status);
    onHeaders?.(r.headers);
    return (await r.json()) as T;
  }
}

function endpointKey(url: URL): string {
  const path = url.pathname;
  if (path === '/platform/segmentations') return 'segmentations.list';
  if (/^\/platform\/segmentations\/[^/]+\/contacts$/.test(path)) return 'segmentations.contacts';
  if (/^\/platform\/contacts\/[^/]+\/events$/.test(path)) return 'contacts.events';
  if (/^\/platform\/contacts\/[^/]+\/funnels\/[^/]+$/.test(path)) return 'contacts.funnels';
  if (/^\/platform\/contacts\/uuid:[^/]+$/.test(path)) return 'contacts.detail';
  if (path === '/platform/analytics/conversions') return 'analytics.conversions';
  if (path === '/platform/analytics/funnel') return 'analytics.funnel';
  return `${url.protocol}//${url.host}${path}`;
}
