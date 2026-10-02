import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RdConnectionService } from './rd-connection.service';
import { RdRefreshBudgetService } from './rd-refresh-budget.service';
import { RdRefreshService } from './rd-refresh.service';
import { RdSyncService } from './rd-sync.service';
import { RdProviderError } from '../common/errors';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('rotating refresh against disposable Postgres', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled' } } });
  const accountId = `refresh-${crypto.randomUUID()}`;
  const rollbackAccountId = `refresh-rollback-${crypto.randomUUID()}`;
  const runId = `${accountId}-run`;
  const ids = ['s1', 's2', 's3'].map((s) => `${accountId}-${s}`);
  const budget = new RdRefreshBudgetService(db as unknown as PrismaService);
  const calls: string[] = [];
  let force401 = false;
  let removeCurrentMembership = false;
  const conversions = Array.from({ length: 20 }, (_, i) => ({ event_type: 'CONVERSION' as const, event_identifier: `fixture-${i}`, event_timestamp: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`, payload: {} }));
  const conn = {
    client: async (_id: string, beforeRequest?: () => Promise<void>) => ({
      get: async (path: string, query?: { page?: number; event_type?: string }) => {
        await beforeRequest?.();
        calls.push(`${path}|${query?.event_type ?? ''}|${query?.page ?? ''}`);
        if (force401) throw new RdProviderError('Unauthorized', 401);
        if (path.includes('/events')) {
          if (query?.event_type === 'CONVERSION') return { events: conversions.slice(((query.page ?? 1) - 1) * 10, (query.page ?? 1) * 10) };
          return { events: [] };
        }
        if (removeCurrentMembership) {
          removeCurrentMembership = false;
          await db.leadSegmentMembership.deleteMany({ where: { accountId, leadRdUuid: 'removed-during-refresh' } });
        }
        if (path.endsWith('/funnels/default')) return { lifecycle_stage: 'Lead', fit: 'A', interest: 1, opportunity: false };
        return { uuid: path.split('uuid:')[1], name: 'Fixture', email: null, personal_phone: null, mobile_phone: null, tags: [] };
      },
    }),
    marcarErro: async (_accountId: string, error: unknown) => {
      if (error instanceof RdProviderError && error.providerStatus === 401) {
        await db.rdConnection.update({ where: { accountId }, data: { status: 'reauth_required' } });
        return;
      }
      throw new Error('refresh must not mark connection errored');
    },
  } as unknown as RdConnectionService;
  const service = () => new RdRefreshService(db as unknown as PrismaService, conn, new RdSyncService(db as unknown as PrismaService, conn), budget);

  beforeAll(async () => {
    await db.account.create({ data: { id: accountId, name: 'Refresh fixture' } });
    await db.rdConnection.create({ data: { accountId, clientId: 'fixture', clientSecret: 'fixture', status: 'active', refreshDailyBudget: 1 } });
    await db.rdSegmentation.createMany({ data: ids.map((rdId, i) => ({ accountId, rdId, name: rdId, selected: i !== 1, available: i !== 1 })) });
    await db.syncRun.create({ data: { id: runId, accountId, kind: 'refresh', status: 'queued' } });
    const leads = ['union-lead', 'lead-no-recent-conversion', 'late-entry'];
    await db.lead.createMany({ data: leads.map((rdUuid) => ({ accountId, rdUuid, name: rdUuid })) });
    await db.leadSegmentMembership.createMany({ data: [
      { accountId, segmentationRdId: ids[0], leadRdUuid: leads[0], firstSeenAt: new Date('2026-09-01T00:00:00Z') },
      { accountId, segmentationRdId: ids[1], leadRdUuid: leads[0], firstSeenAt: new Date('2026-09-01T00:00:00Z') },
      { accountId, segmentationRdId: ids[2], leadRdUuid: leads[0], firstSeenAt: new Date('2026-09-01T00:00:00Z') },
      { accountId, segmentationRdId: ids[0], leadRdUuid: leads[1], firstSeenAt: new Date('2026-09-01T00:00:00Z') },
    ] });
  });
  afterAll(async () => {
    await db.leadEvent.deleteMany({ where: { accountId } });
    await db.leadSegmentMembership.deleteMany({ where: { accountId } });
    await db.syncRun.deleteMany({ where: { accountId } });
    await db.rdSegmentation.deleteMany({ where: { accountId } });
    await db.lead.deleteMany({ where: { accountId } });
    await db.rdConnection.deleteMany({ where: { accountId } });
    await db.account.deleteMany({ where: { id: accountId } });
    await db.syncRun.deleteMany({ where: { accountId: rollbackAccountId } });
    await db.rdConnection.deleteMany({ where: { accountId: rollbackAccountId } });
    await db.account.deleteMany({ where: { id: rollbackAccountId } });
    await db.$disconnect();
  });

  it('checkpoints budget exhaustion and resumes from the next endpoint request without duplicating the lead', async () => {
    await service().run(accountId, runId);
    const partial = await db.syncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(partial.status).toBe('partial');
    expect(partial.finishedAt).toBeNull();
    expect(partial.error).toBe('Orçamento diário esgotado; atualização será retomada no próximo ciclo.');
    expect(partial.stats).toMatchObject({ currentLeadId: expect.any(String), step: 'funnel', page: 1 });
    expect((await db.rdConnection.findUniqueOrThrow({ where: { accountId } })).lastRefreshAt).toBeNull();
    expect(JSON.stringify(partial.stats)).not.toContain('Fixture');
    const currentUuid = (partial.stats as { currentUuid: string }).currentUuid;
    const lateUuid = 'late-entry';
    await db.leadSegmentMembership.create({ data: { accountId, segmentationRdId: ids[0], leadRdUuid: lateUuid, firstSeenAt: new Date(Date.now() + 60_000) } });
    await db.rdSegmentation.updateMany({ where: { accountId }, data: { selected: false } });
    await service().run(accountId, runId);
    expect((await db.syncRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('paused');
    await db.rdSegmentation.updateMany({ where: { accountId, rdId: { in: [ids[0], ids[2]] } }, data: { selected: true } });
    await db.rdConnection.update({ where: { accountId }, data: { refreshDailyBudget: 3, refreshRequestsUsed: 0, refreshBudgetDay: null } });

    await service().run(accountId, runId);
    const pagedPartial = await db.syncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(pagedPartial.status).toBe('partial');
    expect(pagedPartial.stats).toMatchObject({ step: 'conversions', page: 3 });
    expect(calls.filter((call) => call.includes(currentUuid) && call.includes('CONVERSION'))).toHaveLength(2);
    expect(await db.leadEvent.count({ where: { accountId, type: 'CONVERSION', lead: { rdUuid: currentUuid } } })).toBe(20);

    await db.rdConnection.update({ where: { accountId }, data: { refreshDailyBudget: 20, refreshRequestsUsed: 0, refreshBudgetDay: null } });

    await service().run(accountId, runId);
    const completed = await db.syncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(completed.status).toBe('completed');
    expect(completed.finishedAt).toBeInstanceOf(Date);
    expect(calls.filter((call) => call.includes('union-lead'))).toHaveLength(6);
    expect(calls.filter((call) => call.includes('union-lead') && call.includes('/events')).map((call) => call.split('|').slice(-2).join('|'))).toEqual(['CONVERSION|1', 'CONVERSION|2', 'CONVERSION|3', 'OPPORTUNITY|1']);
    expect(await db.lead.count({ where: { accountId, rdUuid: 'lead-no-recent-conversion' } })).toBe(1);
    expect(calls.filter((call) => call.includes('lead-no-recent-conversion'))).toHaveLength(6);
    expect(calls.some((call) => call.includes(lateUuid))).toBe(false);
    expect((await db.rdConnection.findUniqueOrThrow({ where: { accountId } })).lastRefreshAt).toBeInstanceOf(Date);
    expect((await db.rdConnection.findUniqueOrThrow({ where: { accountId } })).lastRefreshAt).toEqual(completed.finishedAt);
  });

  it('skips the current lead if its selected-segment membership disappears before the next request', async () => {
    await db.rdSegmentation.updateMany({ where: { accountId }, data: { selected: false } });
    const segmentId = `${accountId}-removed-segment`;
    await db.rdSegmentation.create({ data: { accountId, rdId: segmentId, name: segmentId, selected: true, available: true } });
    await db.lead.create({ data: { accountId, rdUuid: 'removed-during-refresh', name: 'Fixture' } });
    await db.leadSegmentMembership.create({ data: { accountId, segmentationRdId: segmentId, leadRdUuid: 'removed-during-refresh' } });
    await db.rdConnection.update({ where: { accountId }, data: { status: 'active', refreshDailyBudget: 10, refreshRequestsUsed: 0, refreshBudgetDay: null } });
    const runId = `${accountId}-removed`;
    await db.syncRun.create({ data: { id: runId, accountId, kind: 'refresh', status: 'queued' } });
    const start = calls.length;
    removeCurrentMembership = true;
    await service().run(accountId, runId);
    expect(calls.slice(start).filter((call) => call.includes('removed-during-refresh'))).toHaveLength(1);
    expect((await db.syncRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('completed');
  });

  it('pauses the run and marks the connection for reauthorization after a platform 401', async () => {
    const priorWatermark = (await db.rdConnection.findUniqueOrThrow({ where: { accountId } })).lastRefreshAt;
    const reauthRunId = `${accountId}-reauth`;
    await db.syncRun.create({ data: { id: reauthRunId, accountId, kind: 'refresh', status: 'queued' } });
    await db.rdSegmentation.updateMany({ where: { accountId, rdId: { in: [ids[0], ids[2]] } }, data: { selected: true } });
    await db.rdConnection.update({ where: { accountId }, data: { status: 'active', refreshDailyBudget: 10, refreshRequestsUsed: 0, refreshBudgetDay: null } });
    force401 = true;
    await service().run(accountId, reauthRunId);
    expect((await db.syncRun.findUniqueOrThrow({ where: { id: reauthRunId } })).status).toBe('paused');
    expect((await db.rdConnection.findUniqueOrThrow({ where: { accountId } })).status).toBe('reauth_required');
    expect((await db.rdConnection.findUniqueOrThrow({ where: { accountId } })).lastRefreshAt).toEqual(priorWatermark);
  });

  it('rolls back the finished run when recording the refresh watermark fails', async () => {
    await db.account.create({ data: { id: rollbackAccountId, name: 'Refresh rollback fixture' } });
    await db.rdConnection.create({ data: { accountId: rollbackAccountId, clientId: 'fixture', clientSecret: 'fixture', status: 'active' } });
    const rollbackRunId = `${rollbackAccountId}-run`;
    await db.syncRun.create({ data: { id: rollbackRunId, accountId: rollbackAccountId, kind: 'refresh', status: 'queued' } });
    const failingDb = db.$extends({ query: { rdConnection: { update: async ({ args, query }) => {
      if ('lastRefreshAt' in args.data) throw new Error('simulated watermark write failure');
      return query(args);
    } } } });
    const scanner = new RdRefreshService(
      failingDb as unknown as PrismaService,
      conn,
      new RdSyncService(failingDb as unknown as PrismaService, conn),
      budget,
    );
    await expect(scanner.run(rollbackAccountId, rollbackRunId)).rejects.toThrow('simulated watermark write failure');
    const run = await db.syncRun.findUniqueOrThrow({ where: { id: rollbackRunId } });
    expect(run.finishedAt).toBeNull();
    expect(run.status).toBe('partial');
    expect((await db.rdConnection.findUniqueOrThrow({ where: { accountId: rollbackAccountId } })).lastRefreshAt).toBeNull();
  });
});
