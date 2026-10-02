import { authStore } from './authStore';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly errors?: Array<{ path: string; message: string }>) { super(message); this.name = 'ApiError'; }
}
const BASE = '/api';
let refreshing: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  try {
    const r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (!r.ok) return null;
    const b = (await r.json()) as { accessToken: string };
    authStore.set(b.accessToken);
    return b.accessToken;
  } catch { return null; }
}
export function refreshOnce(): Promise<string | null> { refreshing ??= doRefresh().finally(() => { refreshing = null; }); return refreshing; }

function raw(path: string, init: RequestInit, token: string | null): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, credentials: 'include', headers: { ...(init.body != null ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
}

async function fetchResponse(path: string, init: RequestInit = {}): Promise<Response> {
  let res = await raw(path, init, authStore.get());
  if (res.status === 401 && !path.startsWith('/auth/')) {
    const t = await refreshOnce();
    if (!t) { authStore.notifyUnauthorized(); throw new ApiError(401, 'UNAUTHORIZED', 'Sessão expirada'); }
    res = await raw(path, init, t);
  }
  return res;
}

function throwApiError(status: number, body: unknown): never {
  const error = typeof body === 'object' && body !== null ? body as { code?: string; message?: string; errors?: Array<{ path: string; message: string }> } : {};
  throw new ApiError(status, error.code ?? 'ERROR', error.message ?? `Erro ${status}`, error.errors);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchResponse(path, init);
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throwApiError(res.status, body);
  return body as T;
}

async function stream(path: string): Promise<Response> {
  const res = await fetchResponse(path);
  if (!res.ok) {
    const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
    throwApiError(res.status, body);
  }
  return res;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  stream,
  post: <T>(p: string, data?: unknown) => request<T>(p, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) }),
  put: <T>(p: string, data: unknown) => request<T>(p, { method: 'PUT', body: JSON.stringify(data) }),
  delete: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
  patch: <T>(p: string, data: unknown) => request<T>(p, { method: 'PATCH', body: JSON.stringify(data) }),
};
export const qs = (o: Record<string, unknown>): string => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== null) u.set(k, Array.isArray(v) ? v.join(',') : String(v)); const s = u.toString(); return s ? `?${s}` : ''; };
