import type { Prisma } from '@prisma/client';

export interface RdContact { uuid: string; name?: string | null; email?: string | null; personal_phone?: string | null; mobile_phone?: string | null; city?: string | null; state?: string | null; country?: string | null; job_title?: string | null; website?: string | null; tags?: string[]; created_at?: string; [k: string]: unknown }
export interface RdFunnel { lifecycle_stage?: string | null; opportunity?: boolean | null; fit?: string | number | null; interest?: number | null }
export interface RdEvent { event_type: 'CONVERSION' | 'OPPORTUNITY'; event_identifier: string; event_timestamp: string; payload?: Record<string, unknown> }

export function assertRdFunnel(value: unknown): asserts value is RdFunnel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Campos inválidos ao consultar funil RD');
  const funnel = value as Record<string, unknown>;
  if ((funnel.lifecycle_stage != null && typeof funnel.lifecycle_stage !== 'string')
    || (funnel.fit != null && typeof funnel.fit !== 'string' && !(typeof funnel.fit === 'number' && Number.isFinite(funnel.fit)))
    || (funnel.opportunity != null && typeof funnel.opportunity !== 'boolean')
    || (funnel.interest != null && !Number.isInteger(funnel.interest))) throw new Error('Campos inválidos ao consultar funil RD');
}

export const rdEventKey = (event: RdEvent): string => JSON.stringify([event.event_type, event.event_identifier, new Date(event.event_timestamp).getTime()]);

const PADRAO = new Set(['uuid', 'name', 'email', 'personal_phone', 'mobile_phone', 'city', 'state', 'country', 'job_title', 'website', 'tags', 'created_at', 'links', 'extra_emails', 'legal_bases', 'bio', 'birthdate', 'twitter', 'facebook', 'linkedin']);

export function mapContact(c: RdContact, funnel: RdFunnel | null, events: RdEvent[]): { lead: Omit<Prisma.LeadUncheckedCreateInput, 'accountId'>; events: Array<{ type: 'CONVERSION' | 'OPPORTUNITY'; identifier: string; occurredAt: Date; payload: Prisma.InputJsonValue }> } {
  const customFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (!PADRAO.has(k)) customFields[k] = v;
  const uniqueEvents = [...new Map(events.map((event) => [rdEventKey(event), event])).values()];
  const conv = uniqueEvents.filter((e) => e.event_type === 'CONVERSION').map((e) => new Date(e.event_timestamp)).sort((a, b) => a.getTime() - b.getTime());
  return {
    lead: {
      rdUuid: c.uuid, name: c.name ?? null, email: c.email ?? null, phone: c.personal_phone ?? c.mobile_phone ?? null,
      city: c.city ?? null, state: c.state ?? null, country: c.country ?? null, jobTitle: c.job_title ?? null, website: c.website ?? null,
      tags: c.tags ?? [], lifecycleStage: funnel?.lifecycle_stage ?? null, opportunity: funnel?.opportunity ?? false, fit: funnel?.fit != null ? String(funnel.fit) : null, interest: funnel?.interest ?? null,
      conversionsCount: conv.length, firstConversionAt: conv[0] ?? null, lastConversionAt: conv[conv.length - 1] ?? null,
      rdCreatedAt: c.created_at ? new Date(c.created_at) : null, customFields: customFields as Prisma.InputJsonValue, raw: c as Prisma.InputJsonValue, syncedAt: new Date(),
    },
    events: uniqueEvents.map((e) => ({ type: e.event_type, identifier: e.event_identifier, occurredAt: new Date(e.event_timestamp), payload: (e.payload ?? {}) as Prisma.InputJsonValue })),
  };
}
