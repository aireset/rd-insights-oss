import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RdConnectionService } from './rd-connection.service';
import { RdSyncService } from './rd-sync.service';
import { RdProviderError } from '../common/errors';

const url = process.env.DATABASE_TEST_URL;

describe.skipIf(!url)('endpoint coverage against disposable Postgres', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled' } } });
  const accountId = `coverage-${crypto.randomUUID()}`;
  const contacts: Record<string, Record<string, unknown>> = {};
  const funnels: Record<string, Record<string, unknown> | null> = {};
  const eventFailures: Record<string, number> = {};
  const malformedEventTypes = new Set<string>();
  let malformedEvent: Record<string, unknown> | null = null;
  const calls: Array<{ path: string; type?: string }> = [];
  const client = { get: vi.fn(async (path: string, query?: { event_type?: string; page?: number }) => {
    calls.push({ path, type: query?.event_type });
    if (path.includes('/segmentations/')) return { contacts: query?.page === 1 ? [{ uuid: 'partial-history-lead' }] : [] };
    const uuid = path.match(/uuid:([^/]+)/)?.[1] ?? path.match(/contacts\/([^/]+)\/events/)?.[1];
    if (path.endsWith('/funnels/default')) {
      const value = funnels[uuid!];
      if (value === null) throw new RdProviderError('provider response included secret-token', 404);
      return value ?? { lifecycle_stage: 'Lead', opportunity: false, fit: 'A', interest: 5 };
    }
    if (path.endsWith('/events')) {
      if (malformedEvent) return { events: [malformedEvent] };
      if (malformedEventTypes.has(query!.event_type!)) return {};
      const status = eventFailures[query!.event_type!];
      if (status) throw new RdProviderError(`secret-token provider failure ${status}`, status);
      return { events: query?.event_type === 'CONVERSION' ? [{ event_type: 'CONVERSION', event_identifier: 'form', event_timestamp: '2026-09-01T00:00:00Z' }] : [] };
    }
    return contacts[uuid!] ?? { uuid, name: 'Lead' };
  }) };
  const svc = new RdSyncService(db as unknown as PrismaService, { client: async () => client, marcarErro: vi.fn() } as unknown as RdConnectionService);
  const run = async (uuid: string) => svc.upsertContato(accountId, client as never, uuid);
  const lead = (uuid: string) => db.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } } });

  beforeAll(async () => {
    await db.account.create({ data: { id: accountId, name: 'Coverage fixture' } });
    await db.rdConnection.create({ data: { accountId, clientId: 'test-only', clientSecret: 'test-only' } });
  });
  afterAll(async () => {
    await db.leadEvent.deleteMany({ where: { accountId } });
    await db.lead.deleteMany({ where: { accountId } });
    await db.syncRun.deleteMany({ where: { accountId } });
    await db.rdSegmentation.deleteMany({ where: { accountId } });
    await db.rdConnection.deleteMany({ where: { accountId } });
    await db.account.deleteMany({ where: { id: accountId } });
    await db.$disconnect();
  });

  it('leaves legacy rows unknown and records omitted detail fields', async () => {
    await db.lead.create({ data: { accountId, rdUuid: 'legacy' } });
    expect((await lead('legacy')).dataCoverage).toEqual({});

    contacts.omitted = { uuid: 'omitted', name: 'Ana' };
    await run('omitted');
    const coverage = (await lead('omitted')).dataCoverage as { details: { status: string }; missingFields: string[] };
    expect(coverage.details.status).toBe('available');
    expect(coverage.missingFields).toEqual(expect.arrayContaining(['email', 'phone', 'jobTitle', 'city', 'state']));

    contacts['mobile-only'] = { uuid: 'mobile-only', name: 'Bia', mobile_phone: '11999999999' };
    await db.lead.create({ data: { accountId, rdUuid: 'mobile-only', phone: 'old phone' } });
    await run('mobile-only');
    expect((await lead('mobile-only')).phone).toBe('11999999999');
  });

  it('marks a missing optional funnel unavailable and preserves previously known funnel values', async () => {
    await db.lead.create({ data: { accountId, rdUuid: 'funnel-404', lifecycleStage: 'Customer', opportunity: true, fit: 'A', interest: 8 } });
    contacts['funnel-404'] = { uuid: 'funnel-404', name: 'Lead' };
    funnels['funnel-404'] = null;
    await run('funnel-404');
    const saved = await lead('funnel-404');
    expect(saved).toMatchObject({ lifecycleStage: 'Customer', opportunity: true, fit: 'A', interest: 8 });
    expect((saved.dataCoverage as { funnel: { status: string } }).funnel.status).toBe('unavailable');
  });

  it('keeps successful conversions when opportunities are forbidden and does not advance history freshness', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    await db.lead.create({ data: { accountId, rdUuid: 'event-403', historySyncedAt: old } });
    eventFailures.OPPORTUNITY = 403;
    await expect(run('event-403')).rejects.toThrow();
    eventFailures.OPPORTUNITY = 0;
    const saved = await lead('event-403');
    expect(saved.historySyncedAt).toEqual(old);
    expect(saved.conversionsCount).toBe(1);
    expect(await db.leadEvent.count({ where: { accountId, lead: { rdUuid: 'event-403' }, type: 'CONVERSION' } })).toBe(1);
    expect(saved.dataCoverage).toMatchObject({ conversions: { status: 'available' }, opportunities: { status: 'unavailable' } });
    expect(JSON.stringify(saved.dataCoverage)).not.toContain('secret-token');
  });

  it('keeps freshness after temporary event failures and completes it only when both event endpoints succeed', async () => {
    const old = new Date('2026-01-02T00:00:00Z');
    await db.lead.create({ data: { accountId, rdUuid: 'event-503', historySyncedAt: old } });
    eventFailures.CONVERSION = 503;
    await expect(run('event-503')).rejects.toThrow();
    eventFailures.CONVERSION = 0;
    const partial = await lead('event-503');
    expect(partial.historySyncedAt).toEqual(old);
    expect((partial.dataCoverage as { conversions: { status: string } }).conversions.status).toBe('partial');

    await run('complete');
    const complete = await lead('complete');
    expect(complete.historySyncedAt).toBeInstanceOf(Date);
    expect(complete.dataCoverage).toMatchObject({ conversions: { status: 'available' }, opportunities: { status: 'available' } });
  });

  it('marks a reconcile run partial when one history endpoint fails', async () => {
    await db.rdSegmentation.create({ data: { accountId, rdId: 'partial-history', name: 'Partial history', selected: true } });
    const old = new Date('2026-01-03T00:00:00Z');
    await db.lead.create({ data: { accountId, rdUuid: 'partial-history-lead', historySyncedAt: old } });
    const run = await db.syncRun.create({ data: { accountId, segmentId: 'partial-history', kind: 'full' } });
    eventFailures.OPPORTUNITY = 403;
    await expect(svc.reconcileSegment(accountId, 'partial-history', run.id)).rejects.toThrow();
    eventFailures.OPPORTUNITY = 0;

    expect(await db.syncRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'partial', finishedAt: null });
    expect((await lead('partial-history-lead')).historySyncedAt).toEqual(old);
    expect(await db.leadEvent.count({ where: { accountId, lead: { rdUuid: 'partial-history-lead' }, type: 'CONVERSION' } })).toBe(1);
  });

  it('preserves provider auth status so a 401 run pauses', async () => {
    await db.rdSegmentation.create({ data: { accountId, rdId: 'auth-failure', name: 'Auth failure', selected: true } });
    await db.rdConnection.update({ where: { accountId }, data: { status: 'active' } });
    const run = await db.syncRun.create({ data: { accountId, segmentId: 'auth-failure', kind: 'delta' } });
    eventFailures.CONVERSION = 401;
    await expect(svc.reconcileSegment(accountId, 'auth-failure', run.id)).rejects.toThrow();
    eventFailures.CONVERSION = 0;
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'paused' });
  });

  it('treats a malformed successful event response as partial and preserves freshness', async () => {
    const old = new Date('2026-01-04T00:00:00Z');
    await db.lead.create({ data: { accountId, rdUuid: 'malformed-events', historySyncedAt: old } });
    malformedEventTypes.add('CONVERSION');
    await expect(run('malformed-events')).rejects.toThrow();
    malformedEventTypes.delete('CONVERSION');
    const saved = await lead('malformed-events');
    expect(saved.historySyncedAt).toEqual(old);
    expect((saved.dataCoverage as { conversions: { status: string } }).conversions.status).toBe('partial');
  });

  it.each([
    { event_type: 'CONVERSION', event_identifier: 'bad-date', event_timestamp: 'invalid-date' },
    { event_type: 'UNKNOWN', event_identifier: 'bad-type', event_timestamp: '2026-09-01T00:00:00Z' },
  ])('keeps invalid event records partial: $event_identifier', async (event) => {
    const uuid = event.event_identifier;
    const old = new Date('2026-01-04T00:00:00Z');
    await db.lead.create({ data: { accountId, rdUuid: uuid, historySyncedAt: old } });
    malformedEvent = event;
    try { await expect(run(uuid)).rejects.toThrow(); }
    finally { malformedEvent = null; }
    const saved = await lead(uuid);
    expect(saved.historySyncedAt).toEqual(old);
    expect(saved.dataCoverage).toMatchObject({ conversions: { status: 'partial' } });
    expect(await db.leadEvent.count({ where: { accountId, lead: { rdUuid: uuid } } })).toBe(0);
  });

  it('does not mark malformed contact details as a fresh successful read', async () => {
    const old = new Date('2026-01-05T00:00:00Z');
    await db.lead.update({ where: { accountId_rdUuid: { accountId, rdUuid: 'partial-history-lead' } }, data: { enrichedAt: old } });
    contacts['partial-history-lead'] = {};
    await db.rdSegmentation.create({ data: { accountId, rdId: 'bad-details', name: 'Bad details', selected: true } });
    const scan = await db.syncRun.create({ data: { accountId, segmentId: 'bad-details', kind: 'full' } });
    await expect(svc.reconcileSegment(accountId, 'bad-details', scan.id)).rejects.toThrow();
    const saved = await lead('partial-history-lead');
    expect(saved.enrichedAt).toEqual(old);
    expect(saved.dataCoverage).toMatchObject({ details: { status: 'partial' } });
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({ status: 'partial', finishedAt: null });
  });

  it.each([{ email: 42 }, { tags: 'invalid' }, { created_at: 'invalid' }])('records malformed mapped contact fields as partial: %j', async (invalid) => {
    const old = new Date('2026-01-05T00:00:00Z');
    await db.lead.update({ where: { accountId_rdUuid: { accountId, rdUuid: 'partial-history-lead' } }, data: { enrichedAt: old, dataCoverage: { details: { status: 'available', checkedAt: old.toISOString(), reason: null } } } });
    contacts['partial-history-lead'] = { uuid: 'partial-history-lead', ...invalid };
    const segmentId = `bad-field-${Object.keys(invalid)[0]}`;
    await db.rdSegmentation.create({ data: { accountId, rdId: segmentId, name: 'Bad field', selected: true } });
    const scan = await db.syncRun.create({ data: { accountId, segmentId, kind: 'full' } });
    await expect(svc.reconcileSegment(accountId, segmentId, scan.id)).rejects.toThrow();
    const saved = await lead('partial-history-lead');
    expect(saved.enrichedAt).toEqual(old);
    expect(saved.dataCoverage).toMatchObject({ details: { status: 'partial' } });
  });

  it('records malformed funnel fields as partial without refreshing details', async () => {
    const old = new Date('2026-01-05T00:00:00Z');
    await db.lead.create({ data: { accountId, rdUuid: 'bad-funnel', enrichedAt: old } });
    funnels['bad-funnel'] = { interest: 'invalid' };
    await expect(run('bad-funnel')).rejects.toThrow();
    const saved = await lead('bad-funnel');
    expect(saved.enrichedAt).toEqual(old);
    expect(saved.dataCoverage).toMatchObject({ funnel: { status: 'partial' } });
  });
});
