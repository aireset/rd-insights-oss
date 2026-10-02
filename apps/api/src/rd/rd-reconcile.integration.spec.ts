import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { RdSyncService } from './rd-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RdConnectionService } from './rd-connection.service';
import { RdProviderError } from '../common/errors';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('delta reconciliation against disposable Postgres', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled' } } });
  const accountId = `delta-${crypto.randomUUID()}`;
  const pages: Record<string, Record<number, string[]>> = {};
  const hints: Record<string, string | null> = {};
  const events: Record<string, unknown[]> = {};
  const calls: Array<{ path: string; page?: number; type?: string }> = [];
  let failure: (call: { path: string; page?: number; type?: string }) => boolean = () => false;
  let failureError: Error = new Error('injected delta failure');
  const client = { get: vi.fn(async (path: string, query?: { page?: number; event_type?: string }) => {
    const call = { path, page: query?.page, type: query?.event_type };
    calls.push(call);
    if (failure(call)) throw failureError;
    const segment = path.match(/segmentations\/([^/]+)\/contacts/)?.[1];
    if (segment) return { contacts: (pages[segment]?.[query!.page!] ?? []).map((uuid) => ({ uuid, name: `page ${uuid}`, ...(Object.hasOwn(hints, uuid) ? { last_conversion_date: hints[uuid] } : {}) })) };
    if (path.endsWith('/funnels/default')) return { lifecycle_stage: 'Lead' };
    if (path.endsWith('/events')) return { events: events[path.split('/contacts/')[1]?.split('/events')[0] ?? ''] ?? [] };
    return { uuid: path.split('uuid:')[1], name: `detail ${path.split('uuid:')[1]}` };
  }) };
  const svc = new RdSyncService(db as unknown as PrismaService, { client: async () => client, marcarErro: vi.fn() } as unknown as RdConnectionService);
  const segment = async (id: string, segmentPages: Record<number, string[]>) => {
    pages[id] = segmentPages;
    await db.rdSegmentation.create({ data: { accountId, rdId: id, name: id, selected: true } });
  };
  const run = async (id: string) => db.syncRun.create({ data: { accountId, segmentId: id, kind: 'delta' } });
  const scan = (id: string, runId: string) => svc.reconcileSegment(accountId, id, runId);
  const seedLead = (uuid: string, data: { enrichedAt?: Date | null; historySyncedAt?: Date | null; lastConversionAt?: Date | null; name?: string }) => db.lead.create({ data: { accountId, rdUuid: uuid, ...data } });

  beforeAll(async () => {
    await db.account.create({ data: { id: accountId, name: 'Delta fixture' } });
    await db.rdConnection.create({ data: { accountId, clientId: 'test-only', clientSecret: 'test-only', status: 'active' } });
  });
  afterAll(async () => {
    await db.leadEvent.deleteMany({ where: { accountId } });
    await db.leadSegmentMembership.deleteMany({ where: { accountId } });
    await db.lead.deleteMany({ where: { accountId } });
    await db.syncRun.deleteMany({ where: { accountId } });
    await db.rdSegmentation.deleteMany({ where: { accountId } });
    await db.rdConnection.deleteMany({ where: { accountId } });
    await db.account.deleteMany({ where: { id: accountId } });
    await db.$disconnect();
  });

  it('accepts delta and scans every page despite old conversion dates', async () => {
    await segment('old-pages', { 1: ['old-a'], 2: ['old-b'], 3: [] });
    hints['old-a'] = '2020-01-01T00:00:00Z'; hints['old-b'] = '2020-01-01T00:00:00Z';
    const delta = await run('old-pages');
    await scan('old-pages', delta.id);

    expect(await db.syncRun.findUniqueOrThrow({ where: { id: delta.id } })).toMatchObject({ status: 'completed', finishedAt: expect.any(Date), cursor: 2 });
    expect(await db.leadSegmentMembership.count({ where: { accountId, segmentationRdId: 'old-pages' } })).toBe(2);
    expect(calls.filter((call) => call.path.includes('/segmentations/old-pages/contacts')).map((call) => call.page)).toEqual([1, 2, 3]);
    expect(await db.rdSegmentation.findUniqueOrThrow({ where: { accountId_rdId: { accountId, rdId: 'old-pages' } } })).toMatchObject({ lastDeltaSyncAt: delta.startedAt });
  });

  it('keeps enriched fields and skips detail/history when the conversion hint is unchanged', async () => {
    await segment('unchanged', { 1: ['same'], 2: [] });
    const hint = new Date(Date.now() - 10_000);
    hints.same = hint.toISOString();
    const fresh = new Date();
    await seedLead('same', { name: 'Preserved name', enrichedAt: fresh, historySyncedAt: fresh, lastConversionAt: hint });
    const delta = await run('unchanged');
    calls.length = 0;
    await scan('unchanged', delta.id);

    expect(await db.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: 'same' } } })).toMatchObject({ name: 'Preserved name', lastConversionAt: hint });
    expect(await db.leadSegmentMembership.findUniqueOrThrow({ where: { accountId_segmentationRdId_leadRdUuid: { accountId, segmentationRdId: 'unchanged', leadRdUuid: 'same' } } })).toMatchObject({ eventsPending: false });
    expect(calls.some((call) => call.path === '/platform/contacts/uuid:same' || call.path.endsWith('/uuid:same/events'))).toBe(false);
    expect((await db.syncRun.findUniqueOrThrow({ where: { id: delta.id } })).stats).toMatchObject({ contactsEnriched: 0, contactsWithHistory: 0 });
  });

  it('adds a new membership and removes an absent member only after two completed scans, preserving canonical history', async () => {
    await segment('membership-changes', { 1: ['removed-member'], 2: [] });
    events['removed-member'] = [{ event_type: 'CONVERSION', event_identifier: 'preserved-event', event_timestamp: new Date().toISOString() }];
    await scan('membership-changes', (await run('membership-changes')).id);
    pages['membership-changes'] = { 1: ['added-member'], 2: [] };
    await scan('membership-changes', (await run('membership-changes')).id);
    expect(await db.leadSegmentMembership.findMany({ where: { accountId, segmentationRdId: 'membership-changes' }, orderBy: { leadRdUuid: 'asc' }, select: { leadRdUuid: true, missingScans: true } })).toEqual([
      { leadRdUuid: 'added-member', missingScans: 0 }, { leadRdUuid: 'removed-member', missingScans: 1 },
    ]);
    await scan('membership-changes', (await run('membership-changes')).id);
    expect(await db.leadSegmentMembership.count({ where: { accountId, segmentationRdId: 'membership-changes', leadRdUuid: 'removed-member' } })).toBe(0);
    expect(await db.lead.count({ where: { accountId, rdUuid: 'removed-member' } })).toBe(1);
    expect(await db.leadEvent.count({ where: { accountId, identifier: 'preserved-event' } })).toBe(1);
  });

  it('loads history when a fresh lead has a newer valid conversion hint', async () => {
    await segment('changed-hint', { 1: ['changed'], 2: [] });
    const prior = new Date(Date.now() - 60_000);
    hints.changed = new Date().toISOString();
    await seedLead('changed', { name: 'Keep me', enrichedAt: new Date(), historySyncedAt: new Date(), lastConversionAt: prior });
    events.changed = [{ event_type: 'CONVERSION', event_identifier: 'new-form', event_timestamp: new Date().toISOString() }];
    const delta = await run('changed-hint');
    await scan('changed-hint', delta.id);

    expect(await db.leadEvent.count({ where: { accountId, identifier: 'new-form' } })).toBe(1);
    expect(await db.leadSegmentMembership.findUniqueOrThrow({ where: { accountId_segmentationRdId_leadRdUuid: { accountId, segmentationRdId: 'changed-hint', leadRdUuid: 'changed' } } })).toMatchObject({ eventsPending: false });
    expect((await db.syncRun.findUniqueOrThrow({ where: { id: delta.id } })).stats).toMatchObject({ contactsEnriched: 0, contactsWithHistory: 1 });
  });

  it('uses the one-hour history fallback only for missing or invalid hints', async () => {
    await segment('fallback', { 1: ['fresh-fallback', 'stale-fallback'], 2: [] });
    const recent = new Date();
    hints['stale-fallback'] = 'not-a-date';
    await seedLead('fresh-fallback', { enrichedAt: recent, historySyncedAt: recent, lastConversionAt: null });
    await seedLead('stale-fallback', { enrichedAt: recent, historySyncedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), lastConversionAt: null });
    const delta = await run('fallback');
    calls.length = 0;
    await scan('fallback', delta.id);

    expect(calls.filter((call) => call.path.endsWith('/events')).map((call) => call.path)).toEqual([
      '/platform/contacts/stale-fallback/events', '/platform/contacts/stale-fallback/events',
    ]);
    expect((await db.syncRun.findUniqueOrThrow({ where: { id: delta.id } })).stats).toMatchObject({ contactsWithHistory: 1 });
  });

  it('resumes after a page failure without losing the completed page', async () => {
    await segment('page-resume', { 1: ['page-a'], 2: ['page-b'], 3: [] });
    const delta = await run('page-resume');
    failure = (call) => call.path.includes('/segmentations/page-resume/contacts') && call.page === 2;
    await expect(scan('page-resume', delta.id)).rejects.toThrow('injected delta failure');
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: delta.id } })).toMatchObject({ cursor: 1, status: 'partial' });
    expect(await db.leadSegmentMembership.count({ where: { accountId, segmentationRdId: 'page-resume' } })).toBe(1);

    failure = () => false; calls.length = 0;
    await scan('page-resume', delta.id);
    expect(calls.filter((call) => call.path.includes('/segmentations/page-resume/contacts')).map((call) => call.page)).toEqual([2, 3]);
    expect(await db.leadSegmentMembership.count({ where: { accountId, segmentationRdId: 'page-resume' } })).toBe(2);
  });

  it('keeps pending history and the old watermark after failure, then clears both on resume', async () => {
    await segment('history-resume', { 1: ['history-lead'], 2: [] });
    await seedLead('history-lead', { enrichedAt: new Date(), historySyncedAt: null });
    const oldWatermark = new Date('2026-01-01T00:00:00Z');
    await db.rdSegmentation.update({ where: { accountId_rdId: { accountId, rdId: 'history-resume' } }, data: { lastDeltaSyncAt: oldWatermark } });
    const delta = await run('history-resume');
    failure = (call) => call.path.endsWith('/history-lead/events') && call.type === 'CONVERSION';
    await expect(scan('history-resume', delta.id)).rejects.toThrow('injected delta failure');
    expect(await db.leadSegmentMembership.findUniqueOrThrow({ where: { accountId_segmentationRdId_leadRdUuid: { accountId, segmentationRdId: 'history-resume', leadRdUuid: 'history-lead' } } })).toMatchObject({ eventsPending: true });
    expect((await db.rdSegmentation.findUniqueOrThrow({ where: { accountId_rdId: { accountId, rdId: 'history-resume' } } })).lastDeltaSyncAt).toEqual(oldWatermark);

    failure = () => false;
    await scan('history-resume', delta.id);
    expect(await db.leadSegmentMembership.findUniqueOrThrow({ where: { accountId_segmentationRdId_leadRdUuid: { accountId, segmentationRdId: 'history-resume', leadRdUuid: 'history-lead' } } })).toMatchObject({ eventsPending: false });
    expect((await db.rdSegmentation.findUniqueOrThrow({ where: { accountId_rdId: { accountId, rdId: 'history-resume' } } })).lastDeltaSyncAt).toEqual(delta.startedAt);
  });

  it('deduplicates an overlapping lead and advances only the completed segment watermark', async () => {
    await segment('overlap-a', { 1: ['shared'], 2: [] });
    await segment('overlap-b', { 1: ['shared'], 2: [] });
    hints.shared = new Date().toISOString();
    events.shared = [{ event_type: 'CONVERSION', event_identifier: 'shared-form', event_timestamp: hints.shared }];
    const first = await run('overlap-a');
    const second = await run('overlap-b');
    await scan('overlap-a', first.id);
    expect((await db.rdSegmentation.findUniqueOrThrow({ where: { accountId_rdId: { accountId, rdId: 'overlap-a' } } })).lastDeltaSyncAt).toEqual(first.startedAt);
    expect((await db.rdSegmentation.findUniqueOrThrow({ where: { accountId_rdId: { accountId, rdId: 'overlap-b' } } })).lastDeltaSyncAt).toBeNull();
    calls.length = 0;
    await scan('overlap-b', second.id);

    expect(await db.lead.count({ where: { accountId, rdUuid: 'shared' } })).toBe(1);
    expect(await db.leadEvent.count({ where: { accountId, identifier: 'shared-form' } })).toBe(1);
    expect(calls.some((call) => call.path === '/platform/contacts/uuid:shared')).toBe(false);
    expect((await db.rdSegmentation.findUniqueOrThrow({ where: { accountId_rdId: { accountId, rdId: 'overlap-a' } } })).lastDeltaSyncAt).toEqual(first.startedAt);
    expect((await db.rdSegmentation.findUniqueOrThrow({ where: { accountId_rdId: { accountId, rdId: 'overlap-b' } } })).lastDeltaSyncAt).toEqual(second.startedAt);
  });

  it.each(['reauth_required', 'pending', 'authorized'] as const)('pauses %s runs before provider calls and preserves checkpoints', async (status) => {
    const segmentId = `paused-${status}`;
    await segment(segmentId, { 1: ['never-called'], 2: [] });
    const delta = await run(segmentId);
    await db.rdConnection.update({ where: { accountId }, data: { status } });
    calls.length = 0;
    await scan(segmentId, delta.id);

    expect(calls).toEqual([]);
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: delta.id } })).toMatchObject({ status: 'paused', cursor: 0, finishedAt: null });
    expect((await db.rdSegmentation.findUniqueOrThrow({ where: { accountId_rdId: { accountId, rdId: segmentId } } })).lastDeltaSyncAt).toBeNull();
    await db.rdConnection.update({ where: { accountId }, data: { status: 'active' } });
  });

  it('pauses a deselected segment without provider calls or checkpoint loss', async () => {
    await segment('deselected', { 1: ['never-called-either'], 2: [] });
    const delta = await run('deselected');
    await db.rdSegmentation.update({ where: { accountId_rdId: { accountId, rdId: 'deselected' } }, data: { selected: false } });
    calls.length = 0;
    await scan('deselected', delta.id);

    expect(calls).toEqual([]);
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: delta.id } })).toMatchObject({ status: 'paused', cursor: 0, finishedAt: null });
  });

  it('pauses after a provider 401 and retains the prior watermark', async () => {
    await segment('provider-reauth', { 1: ['unauthorized'], 2: [] });
    const delta = await run('provider-reauth');
    failure = (call) => call.path.includes('/segmentations/provider-reauth/contacts');
    failureError = new RdProviderError('reauthorize', 401);
    await expect(scan('provider-reauth', delta.id)).rejects.toThrow('reauthorize');
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: delta.id } })).toMatchObject({ status: 'paused', cursor: 0, finishedAt: null });
    expect((await db.rdSegmentation.findUniqueOrThrow({ where: { accountId_rdId: { accountId, rdId: 'provider-reauth' } } })).lastDeltaSyncAt).toBeNull();
    failure = () => false; failureError = new Error('injected delta failure');
    await db.rdConnection.update({ where: { accountId }, data: { status: 'active' } });
  });
});
