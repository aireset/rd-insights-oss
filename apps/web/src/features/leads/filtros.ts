import { leadsQuerySchema, type LeadsQuery } from '@rd/shared';

export type Filtros = Partial<LeadsQuery>;
export function fromSearch(sp: URLSearchParams): LeadsQuery {
  return leadsQuerySchema.parse(Object.fromEntries(sp.entries()));
}
export function toSearch(f: Filtros): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === '' || v === null) continue;
    u.set(k, Array.isArray(v) ? (k === 'segmentIds' ? [...new Set(v)] : v).join(',') : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  }
  return u.toString();
}
