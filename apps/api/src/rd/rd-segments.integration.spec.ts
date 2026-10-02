import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { RdSyncService } from './rd-sync.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RdConnectionService } from './rd-connection.service';
import { RdJobsService } from './rd-jobs.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { RdProviderError } from '../common/errors';
import { LeadsService } from '../leads/leads.service';
import { leadsQuerySchema } from '@rd/shared';
import { Queue } from 'bullmq';

// Only an explicitly supplied disposable database is used; never DATABASE_URL.
const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('segment scans against disposable Postgres', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled' } } });
  const accountId = `segments-${crypto.randomUUID()}`;
  const pages: Record<string, string[][]> = { A: [['u1', 'u2']], B: [['u2', 'u3']] };
  let failure = '';
  let failureError: Error = new Error('injected failure');
  let invalidContact = '';
  const calls: string[] = [];
  const client = { get: vi.fn(async (path: string, q?: { page?: number; event_type?: string }) => {
    calls.push(path);
    if (path === failure || `${path}?page=${q?.page}` === failure) throw failureError;
    const segment = path.match(/segmentations\/(.+)\/contacts/)?.[1];
    if (segment) return { contacts: (pages[segment]?.[q!.page! - 1] ?? []).map((uuid) => ({ uuid, name: uuid, ...(uuid === invalidContact ? { created_at: 'invalid-date' } : {}) })) };
    if (path.endsWith('/funnels/default')) return { lifecycle_stage: 'Lead' };
    if (path.endsWith('/events')) return { events: q?.event_type === 'CONVERSION' ? [{ event_type: 'CONVERSION', event_identifier: 'form', event_timestamp: '2026-09-01T00:00:00Z' }] : [] };
    return { uuid: path.split('uuid:')[1], name: 'Enriched' };
  }) };
  const svc = new RdSyncService(db as unknown as PrismaService, { client: async () => client, marcarErro: vi.fn() } as unknown as RdConnectionService);
  const scan = async (segmentId: string, runId?: string) => {
    const run = runId ? await db.syncRun.findUniqueOrThrow({ where: { id: runId } }) : await db.syncRun.create({ data: { accountId, segmentId, kind: 'full' } });
    await svc.reconcileSegment(accountId, segmentId, run.id);
    return run.id;
  };
  beforeAll(async () => {
    await db.account.create({ data: { id: accountId, name: 'Isolated test' } });
    await db.rdConnection.create({ data: { accountId, clientId: 'test-only', clientSecret: 'test-only' } });
    await db.rdSegmentation.createMany({ data: ['A', 'B'].map((rdId) => ({ accountId, rdId, name: rdId, selected: true })) });
  });
  afterAll(async () => {
    await db.leadEvent.deleteMany({ where: { accountId } });
    await db.leadSegmentMembership.deleteMany({ where: { accountId } });
    await db.lead.deleteMany({ where: { accountId } });
    await db.syncRun.deleteMany({ where: { accountId } });
    await db.rdConnection.deleteMany({ where: { accountId } });
    await db.account.delete({ where: { id: accountId } });
    await db.$disconnect();
  });
  it('unites A and B as three canonical leads, four memberships and three events', async () => {
    await scan('A'); await scan('B');
    expect(await db.lead.count({ where: { accountId } })).toBe(3);
    expect(await db.leadSegmentMembership.count({ where: { accountId } })).toBe(4);
    expect(await db.leadEvent.count({ where: { accountId } })).toBe(3);
    expect(calls.filter((path) => path === '/platform/contacts/uuid:u2')).toHaveLength(1);
    const leads = new LeadsService(db as unknown as PrismaService);
    expect((await leads.list(accountId, leadsQuerySchema.parse({ segmentIds: ['A', 'B'], segmentMatch: 'any', pageSize: 1 }))).total).toBe(3);
    const intersection = await leads.list(accountId, leadsQuerySchema.parse({ segmentIds: ['A', 'B'], segmentMatch: 'all' }));
    expect(intersection.total).toBe(1);
    expect(intersection.items[0].segments).toEqual([{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]);
    expect((await leads.detail(accountId, intersection.items[0].id)).segments).toEqual(intersection.items[0].segments);
    await db.lead.updateMany({ where: { accountId }, data: { tags: ['same', 'same'] } });
    await db.leadEvent.create({ data: { accountId, leadId: intersection.items[0].id, type: 'CONVERSION', identifier: 'form', occurredAt: new Date('2026-09-02') } });
    const unionFacets = await leads.facets(accountId, leadsQuerySchema.parse({ segmentIds: ['A', 'B'], segmentMatch: 'any' }));
    expect(unionFacets.tags).toEqual([{ value: 'same', count: 3 }]);
    expect(unionFacets.conversoes).toEqual([{ value: 'form', count: 3 }]);
    const allFacets = await leads.facets(accountId, leadsQuerySchema.parse({ segmentIds: ['A', 'B'], segmentMatch: 'all' }));
    expect(allFacets.tags).toEqual([{ value: 'same', count: 1 }]);
    expect(allFacets.conversoes).toEqual([{ value: 'form', count: 1 }]);
    await expect(leads.facets(accountId, leadsQuerySchema.parse({ segmentIds: ['foreign-only'] }))).rejects.toMatchObject({ status: 404 });
  });
  it.skipIf(!process.env.REDIS_TEST_URL)('queues all selected segments once across two API instances', async () => {
    const config = { get: (key: string) => key === 'REDIS_URL' ? process.env.REDIS_TEST_URL : 'test' } as unknown as ConfigService<Env, true>;
    const first = new RdJobsService(config, db as unknown as PrismaService, svc);
    const second = new RdJobsService(config, db as unknown as PrismaService, svc);
    try {
      const responses = await Promise.all([first.enqueueFullSync(accountId), second.enqueueFullSync(accountId)]);
      expect(responses[0].runIds).toHaveLength(2);
      expect(responses[0]).toEqual(responses[1]);
      await expect(first.enqueueFullSync(accountId, ['foreign-only'])).rejects.toMatchObject({ status: 404 });
      for (let i = 0; i < 100; i++) {
        if ((await db.rdConnection.findUnique({ where: { accountId } }))?.lastFullSyncAt) break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(await db.syncRun.count({ where: { id: { in: responses[0].runIds }, status: 'completed' } })).toBe(2);
      expect(await db.lead.count({ where: { accountId } })).toBe(3);
      expect((await db.rdConnection.findUnique({ where: { accountId } }))?.lastFullSyncAt).toBeInstanceOf(Date);
    } finally { await first.beforeApplicationShutdown(); await second.beforeApplicationShutdown(); }
  });
  it.skipIf(!process.env.REDIS_TEST_URL)('serializes one account selection while allowing another account to progress', async () => {
    const ids = [`parallel-${crypto.randomUUID()}`, `parallel-${crypto.randomUUID()}`];
    for (const id of ids) {
      await db.account.create({ data: { id, name: 'Parallel fixture' } });
      await db.rdConnection.create({ data: { accountId: id, clientId: 'test-only', clientSecret: 'test-only' } });
      await db.rdSegmentation.createMany({ data: ['A', 'B'].map((rdId) => ({ accountId: id, rdId, name: rdId, selected: true })) });
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Set<string>();
    const isolatedSync = { reconcileSegment: async (id: string, _segmentId: string, runId: string) => {
      started.add(id);
      await gate;
      await db.syncRun.update({ where: { id: runId, accountId: id }, data: { finishedAt: new Date(), status: 'completed' } });
    } } as unknown as RdSyncService;
    const config = { get: (key: string) => key === 'REDIS_URL' ? process.env.REDIS_TEST_URL : 'test' } as unknown as ConfigService<Env, true>;
    const first = new RdJobsService(config, db as unknown as PrismaService, isolatedSync);
    const second = new RdJobsService(config, db as unknown as PrismaService, isolatedSync);
    try {
      const raced = await Promise.allSettled([first.enqueueFullSync(ids[0], ['A']), second.enqueueFullSync(ids[0], ['B'])]);
      expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(raced.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
      expect(await db.syncRun.count({ where: { accountId: ids[0] } })).toBe(1);
      const winner = raced[0].status === 'fulfilled' ? 'A' : 'B';
      const accepted = raced.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ runId: string; runIds: string[] }>;
      expect(await second.enqueueFullSync(ids[0], [winner])).toEqual(accepted.value);
      await first.enqueueFullSync(ids[1], ['A']);
      for (let n = 0; n < 100 && started.size < 2; n++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(started.size).toBe(2);
    } finally {
      release();
      await first.beforeApplicationShutdown(); await second.beforeApplicationShutdown();
      await db.syncRun.deleteMany({ where: { accountId: { in: ids } } });
      await db.rdConnection.deleteMany({ where: { accountId: { in: ids } } });
      await db.account.deleteMany({ where: { id: { in: ids } } });
    }
  });
  it.skipIf(!process.env.REDIS_TEST_URL)('rolls back prepared segment runs when Redis refuses queue.add', async () => {
    const id = `rollback-${crypto.randomUUID()}`;
    await db.account.create({ data: { id, name: 'Rollback fixture' } });
    await db.rdConnection.create({ data: { accountId: id, clientId: 'test-only', clientSecret: 'test-only' } });
    await db.rdSegmentation.create({ data: { accountId: id, rdId: 'A', name: 'A', selected: true } });
    const config = { get: (key: string) => key === 'REDIS_URL' ? process.env.REDIS_TEST_URL : 'test' } as unknown as ConfigService<Env, true>;
    const jobs = new RdJobsService(config, db as unknown as PrismaService, svc);
    const add = vi.spyOn(Queue.prototype, 'add').mockRejectedValueOnce(new Error('Redis unavailable fixture'));
    try {
      await expect(jobs.enqueueFullSync(id)).rejects.toMatchObject({ status: 503 });
      expect(await db.syncRun.count({ where: { accountId: id } })).toBe(0);
    } finally {
      add.mockRestore(); await jobs.beforeApplicationShutdown();
      await db.syncRun.deleteMany({ where: { accountId: id } });
      await db.rdConnection.deleteMany({ where: { accountId: id } });
      await db.account.delete({ where: { id } });
    }
  });
  it('retains page 1 and resumes the same generation from page 2', async () => {
    pages.A = [['u1'], ['u4']];
    failure = '/platform/segmentations/A/contacts?page=2';
    const run = await db.syncRun.create({ data: { accountId, segmentId: 'A', kind: 'full' } });
    await expect(scan('A', run.id)).rejects.toThrow('injected failure');
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ cursor: 1, stats: { contactsFailed: 0 } });
    expect(await db.leadSegmentMembership.count({ where: { accountId, segmentationRdId: 'A' } })).toBe(2);
    failure = ''; calls.length = 0;
    await scan('A', run.id);
    expect(calls.filter((path) => path.includes('/segmentations/'))).toHaveLength(2);
    expect(await db.leadSegmentMembership.count({ where: { accountId, segmentationRdId: 'A' } })).toBe(3);
    await scan('A');
    expect(await db.leadSegmentMembership.count({ where: { accountId, segmentationRdId: 'A' } })).toBe(2);
    expect(await db.lead.count({ where: { accountId, rdUuid: 'u2' } })).toBe(1);
  });
  it('keeps complete membership discovery when enrichment fails and resumes its stage', async () => {
    pages.B = [['u5'], ['u6']]; failure = '/platform/contacts/uuid:u5';
    const run = await db.syncRun.create({ data: { accountId, segmentId: 'B', kind: 'full' } });
    await expect(scan('B', run.id)).rejects.toThrow('injected failure');
    expect(await db.leadSegmentMembership.count({ where: { accountId, segmentationRdId: 'B', leadRdUuid: { in: ['u5', 'u6'] } } })).toBe(2);
    expect(await db.rdSegmentation.findUnique({ where: { accountId_rdId: { accountId, rdId: 'B' } } })).toMatchObject({ coverage: 'complete' });
    expect(await db.syncRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'partial', finishedAt: null });
    failure = ''; calls.length = 0;
    await scan('B', run.id);
    expect(calls.some((path) => path.includes('/segmentations/'))).toBe(false);
    expect(await db.syncRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'completed' });
  });
  it('rejects foreign runs and pauses deselected segments without provider calls', async () => {
    const run = await db.syncRun.create({ data: { accountId, segmentId: 'A', kind: 'full' } });
    await expect(svc.reconcileSegment('foreign', 'A', run.id)).rejects.toThrow();
    await db.rdSegmentation.update({ where: { accountId_rdId: { accountId, rdId: 'A' } }, data: { selected: false } });
    calls.length = 0; await scan('A', run.id);
    expect(calls).toEqual([]);
    expect(await db.syncRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: 'paused' });
  });
  it('rejects a membership pointing to a lead from another account', async () => {
    const foreign = await db.account.create({ data: { name: 'Foreign test account' } });
    try {
      await db.lead.create({ data: { accountId: foreign.id, rdUuid: 'foreign-only' } });
      await expect(db.leadSegmentMembership.create({ data: { accountId, segmentationRdId: 'B', leadRdUuid: 'foreign-only' } })).rejects.toMatchObject({ code: 'P2003' });
    } finally {
      await db.lead.deleteMany({ where: { accountId: foreign.id } });
      await db.account.delete({ where: { id: foreign.id } });
    }
  });
  it('continues another selected segment when RD removed the first', async () => {
    await db.rdSegmentation.createMany({ data: ['C', 'D'].map((rdId) => ({ accountId, rdId, name: rdId, selected: true })) });
    const runs = await Promise.all(['C', 'D'].map((segmentId) => db.syncRun.create({ data: { accountId, segmentId, kind: 'full' } })));
    pages.D = [['u7']]; failure = '/platform/segmentations/C/contacts'; failureError = new RdProviderError('RD responded 404', 404);
    const jobs = new RdJobsService({ get: () => undefined } as unknown as ConfigService<Env, true>, db as unknown as PrismaService, svc);
    try {
      await expect(Reflect.get(jobs, 'process').call(jobs, { name: 'sync.full', data: { accountId, runId: runs[0].id, runIds: runs.map((r) => r.id) } })).rejects.toThrow();
      expect(await db.syncRun.findUnique({ where: { id: runs[1].id } })).toMatchObject({ status: 'completed' });
      expect(await db.rdSegmentation.findUnique({ where: { accountId_rdId: { accountId, rdId: 'C' } } })).toMatchObject({ available: false });
    } finally { failure = ''; failureError = new Error('injected failure'); await jobs.beforeApplicationShutdown(); }
  });
  it('rolls back page memberships and cursor together on a persistence failure', async () => {
    await db.rdSegmentation.create({ data: { accountId, rdId: 'E', name: 'E', selected: true } });
    const run = await db.syncRun.create({ data: { accountId, segmentId: 'E', kind: 'full' } });
    pages.E = [['u8', 'u9']]; invalidContact = 'u9';
    try {
      await expect(scan('E', run.id)).rejects.toThrow();
      expect(await db.lead.count({ where: { accountId, rdUuid: { in: ['u8', 'u9'] } } })).toBe(0);
      expect(await db.leadSegmentMembership.count({ where: { accountId, segmentationRdId: 'E' } })).toBe(0);
      expect(await db.syncRun.findUnique({ where: { id: run.id } })).toMatchObject({ cursor: 0 });
    } finally { invalidContact = ''; }
    await scan('E', run.id);
    expect(await db.leadSegmentMembership.count({ where: { accountId, segmentationRdId: 'E' } })).toBe(2);
  });
  it('treats a missing optional funnel as unavailable while retaining known funnel data', async () => {
    await db.rdSegmentation.create({ data: { accountId, rdId: 'F', name: 'F', selected: true } });
    await db.lead.create({ data: { accountId, rdUuid: 'u10', lifecycleStage: 'Customer', opportunity: true } });
    pages.F = [['u10']]; failure = '/platform/contacts/uuid:u10/funnels/default'; failureError = new RdProviderError('Missing optional funnel', 404);
    try {
      await scan('F');
      expect(await db.lead.findUnique({ where: { accountId_rdUuid: { accountId, rdUuid: 'u10' } } })).toMatchObject({ lifecycleStage: 'Customer', opportunity: true, conversionsCount: 1 });
    } finally { failure = ''; failureError = new Error('injected failure'); }
  });
  it('pauses remaining segment runs when the account needs reauthorization', async () => {
    await db.rdSegmentation.createMany({ data: ['H', 'I'].map((rdId) => ({ accountId, rdId, name: rdId, selected: true })) });
    const runs = await Promise.all(['H', 'I'].map((segmentId) => db.syncRun.create({ data: { accountId, segmentId, kind: 'full' } })));
    failure = '/platform/segmentations/H/contacts'; failureError = new RdProviderError('Reauthorize account', 401);
    const jobs = new RdJobsService({ get: () => undefined } as unknown as ConfigService<Env, true>, db as unknown as PrismaService, svc);
    try {
      await expect(Reflect.get(jobs, 'process').call(jobs, { name: 'sync.full', data: { accountId, runId: runs[0].id, runIds: runs.map((r) => r.id) } })).rejects.toThrow();
      expect(await db.syncRun.findUnique({ where: { id: runs[1].id } })).toMatchObject({ status: 'paused', finishedAt: null });
      const before = calls.length;
      await Reflect.get(jobs, 'process').call(jobs, { name: 'sync.full', data: { accountId, runId: runs[1].id } });
      expect(calls).toHaveLength(before);
    } finally { failure = ''; failureError = new Error('injected failure'); await jobs.beforeApplicationShutdown(); }
  });
});
