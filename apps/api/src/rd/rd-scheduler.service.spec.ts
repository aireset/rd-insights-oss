import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import type { Worker } from 'bullmq';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.schema';
import { RdSchedulerService } from './rd-scheduler.service';
import type { RdJobsService } from './rd-jobs.service';
import { redisConnectionOptions } from '../common/redis-connection';
import type { RdAnalyticsService } from './rd-analytics.service';

const redisUrl = process.env.REDIS_TEST_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;
const services: RdSchedulerService[] = [];
const queues: Queue[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.beforeApplicationShutdown()));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  if (redisUrl) {
    const cleanup = makeQueue();
    await cleanup.obliterate({ force: true });
    await cleanup.close();
  }
});

describe('RdSchedulerService dispatch', () => {
  it('reports actual refresh completion and budget without inventing a next execution when Redis is unavailable', async () => {
    const { prisma } = fakePrisma([{ id: 'tenant-a', status: 'active', selected: true, available: true }]);
    prisma.rdConnection.findUnique.mockResolvedValue({ status: 'active', lastRefreshAt: new Date('2026-09-20T10:00:00Z'), refreshDailyBudget: 5, refreshRequestsUsed: 5, refreshBudgetDay: new Date(new Date().toISOString().slice(0, 10)), catalogSyncedAt: null });
    prisma.syncRun.findFirst.mockResolvedValue({ startedAt: new Date('2026-09-28T10:00:00Z'), status: 'partial', stats: { leadsCompleted: 3, step: 'opportunities', page: 2 }, error: 'Budget' });
    const service = makeService(prisma, {} as RdJobsService, { redis: null, daily: true });
    const result = await service.dailyStatus('tenant-a');
    expect(result.refresh).toMatchObject({ state: 'unavailable', nextRunAt: null, lastCompletedAt: '2026-09-20T10:00:00.000Z', budget: { limit: 5, used: 5 }, run: { status: 'partial', leadsCompleted: 3, page: 2 } });
    expect(prisma.syncRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId: 'tenant-a', kind: 'refresh' } }));
  });

  it('exposes segment coverage from the database without calling the RD or inventing freshness', async () => {
    const { prisma } = fakePrisma([]);
    const findMany = vi.fn(async () => [{ rdId: 'a', name: 'Alfa', selected: true, available: true, coverage: 'unknown', lastScanAt: null, lastDeltaSyncAt: null }, { rdId: 'b', name: 'Beta', selected: true, available: true, coverage: 'partial', lastScanAt: new Date('2026-09-28T10:00:00Z'), lastDeltaSyncAt: new Date('2026-09-27T10:00:00Z') }]);
    prisma.rdSegmentation.findMany = findMany as never;
    const service = makeService(prisma, { enqueueReconciliation: vi.fn() } as unknown as RdJobsService, { redis: null });
    expect(await service.coverage('tenant-a')).toEqual([
      { id: 'a', name: 'Alfa', selected: true, available: true, coverage: 'unknown', lastScanAt: null, lastDeltaSyncAt: null },
      { id: 'b', name: 'Beta', selected: true, available: true, coverage: 'partial', lastScanAt: '2026-09-28T10:00:00.000Z', lastDeltaSyncAt: '2026-09-27T10:00:00.000Z' },
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId: 'tenant-a' } }));
  });

  it('visits accounts beyond the first page without repeating accounts', async () => {
    const accounts = Array.from({ length: 101 }, (_, i) => ({ id: `tenant-${String(i).padStart(3, '0')}`, status: 'active', selected: true, available: true }));
    const { prisma } = fakePrisma(accounts);
    const enqueue = vi.fn(async (accountId: string) => ({ runId: accountId, runIds: [accountId] }));
    const service = makeService(prisma, { enqueueReconciliation: enqueue } as unknown as RdJobsService, { redis: null });
    await service.dispatch();
    expect(enqueue.mock.calls.map((args) => args[0])).toEqual(accounts.map(({ id }) => id));
    expect(prisma.account.findMany).toHaveBeenCalledTimes(2);
  });

  it('rechecks eligibility and skips paused segmentations and reauthorization', async () => {
    let invalidateActive = () => {};
    const { prisma, setEligible } = fakePrisma([
      { id: 'active', status: 'active', selected: true, available: true },
      { id: 'paused', status: 'active', selected: true, available: false },
      { id: 'reauth', status: 'reauth_required', selected: true, available: true },
    ], () => invalidateActive());
    // The account becomes ineligible after the keyset page is read but before enqueue.
    invalidateActive = () => setEligible('active', false);
    const jobs = { enqueueReconciliation: vi.fn() } as unknown as RdJobsService;
    const service = makeService(prisma, jobs);

    await service.dispatch();

    expect(jobs.enqueueReconciliation).not.toHaveBeenCalled();
    expect(prisma.account.findFirst).toHaveBeenCalledTimes(1);
  });

  it('continues after one account fails and asks BullMQ to retry the dispatcher', async () => {
    const { prisma } = fakePrisma([
      { id: 'a', status: 'active', selected: true, available: true },
      { id: 'b', status: 'error', selected: true, available: true },
    ], undefined, ['a']);
    const jobs = { enqueueReconciliation: vi.fn(async () => {
      return { runId: 'run-b', runIds: ['run-b'] };
    }) } as unknown as RdJobsService;
    const service = makeService(prisma, jobs);

    await expect(service.dispatch()).rejects.toThrow('Falha ao reconciliar uma ou mais contas');
    expect(jobs.enqueueReconciliation).toHaveBeenCalledTimes(1);
    expect(jobs.enqueueReconciliation).toHaveBeenLastCalledWith('b');
  });

  it('treats 409 and 422 as per-account skips', async () => {
    const { prisma } = fakePrisma([
      { id: 'conflict', status: 'active', selected: true, available: true },
      { id: 'invalid', status: 'active', selected: true, available: true },
    ]);
    const jobs = { enqueueReconciliation: vi.fn(async (accountId: string) => {
      throw Object.assign(new Error('ignored'), { status: accountId === 'conflict' ? 409 : 422 });
    }) } as unknown as RdJobsService;
    const service = makeService(prisma, jobs);

    await expect(service.dispatch()).resolves.toBeUndefined();
    expect(jobs.enqueueReconciliation).toHaveBeenCalledTimes(2);
  });

  it('returns status using only the requested account', async () => {
    const { prisma } = fakePrisma([{ id: 'tenant-a', status: 'active', selected: true, available: true }]);
    prisma.syncRun.findFirst.mockResolvedValue({ startedAt: new Date('2026-09-28T10:00:00.000Z') });
    prisma.rdConnection.findUnique.mockResolvedValue({ status: 'active', lastDeltaSyncAt: new Date('2026-09-28T09:00:00.000Z') });
    const service = makeService(prisma, { enqueueReconciliation: vi.fn() } as unknown as RdJobsService);
    const status = await service.status('tenant-a');

    expect(prisma.rdConnection.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId: 'tenant-a' } }));
    expect(prisma.rdSegmentation.count).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId: 'tenant-a', selected: true, available: true } }));
    expect(prisma.syncRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId: 'tenant-a', kind: 'delta' } }));
    expect(status).toEqual({ enabled: true, state: 'unavailable', intervalMinutes: 60, nextRunAt: null, lastAttemptAt: '2026-09-28T10:00:00.000Z', lastCompletedAt: '2026-09-28T09:00:00.000Z' });
  });
});

describeWithRedis('RdSchedulerService BullMQ runtime', () => {
  it('keeps daily refresh and catalog schedules idempotent across restart', async () => {
    const { prisma } = fakePrisma([{ id: 'tenant-a', status: 'active', selected: true, available: true }]);
    const jobs = { enqueueReconciliation: vi.fn(), enqueueRefresh: vi.fn(), enqueueCatalog: vi.fn() } as unknown as RdJobsService;
    const first = makeService(prisma, jobs, { daily: true });
    const second = makeService(prisma, jobs, { daily: true });
    await first.onModuleInit();
    await second.onModuleInit();
    const queue = makeQueue(); queues.push(queue);
    expect(await queue.getJobSchedulersCount()).toBe(4);
    expect(await queue.getJobScheduler('rd-refresh-daily')).toMatchObject({ pattern: '0 0 2 * * *', tz: 'America/Sao_Paulo' });
    expect(await queue.getJobScheduler('rd-catalog-daily')).toMatchObject({ pattern: '0 30 1 * * *', tz: 'America/Sao_Paulo' });
    await first.dispatch('refresh');
    await first.dispatch('catalog');
    expect(jobs.enqueueRefresh).toHaveBeenCalledWith('tenant-a');
    expect(jobs.enqueueCatalog).toHaveBeenCalledWith('tenant-a');
  });

  it('keeps one persistent scheduler across repeated initialization and exposes its next timestamp', async () => {
    const { prisma } = fakePrisma([{ id: 'tenant-a', status: 'active', selected: true, available: true }]);
    const first = makeService(prisma, { enqueueReconciliation: vi.fn() } as unknown as RdJobsService);
    const second = makeService(prisma, { enqueueReconciliation: vi.fn() } as unknown as RdJobsService);
    services.push(first, second);

    await Promise.all([first.onModuleInit(), second.onModuleInit()]);

    const queue = makeQueue();
    queues.push(queue);
    const scheduler = await queue.getJobScheduler('rd-reconciliation-hourly');
    expect(await queue.getJobSchedulersCount()).toBe(1);
    expect(scheduler).toMatchObject({ name: 'reconcile.tick', every: 3_600_000, next: expect.any(Number) });
    expect((await first.status('tenant-a')).nextRunAt).toBe(new Date(scheduler!.next!).toISOString());
    await (Reflect.get(first, 'worker') as Worker).close();
    expect(await first.status('tenant-a')).toMatchObject({ state: 'unavailable', nextRunAt: null });
  }, 15_000);

  it('removes only its scheduler when disabled', async () => {
    const { prisma } = fakePrisma([]);
    const enabled = makeService(prisma, { enqueueReconciliation: vi.fn() } as unknown as RdJobsService);
    await enabled.onModuleInit();
    const queue = makeQueue();
    queues.push(queue);
    expect(await queue.getJobScheduler('rd-reconciliation-hourly')).toBeDefined();
    await queue.upsertJobScheduler('other-scheduler', { every: 120_000 }, { name: 'other.tick', data: {} });

    const disabled = makeService(prisma, { enqueueReconciliation: vi.fn() } as unknown as RdJobsService, { enabled: false });
    await disabled.onModuleInit();

    expect(await queue.getJobScheduler('rd-reconciliation-hourly')).toBeUndefined();
    expect(await queue.getJobScheduler('other-scheduler')).toBeDefined();
  }, 15_000);
});

describe('RdSchedulerService without Redis', () => {
  it('does not create a worker and reports disabled when the feature flag is off', async () => {
    const { prisma } = fakePrisma([]);
    const service = makeService(prisma, { enqueueReconciliation: vi.fn() } as unknown as RdJobsService, { redis: null, enabled: false });

    await service.onModuleInit();

    expect(Reflect.get(service, 'worker')).toBeUndefined();
    expect(await service.status('tenant-a')).toMatchObject({ state: 'disabled', nextRunAt: null });
  });
});

function makeService(prisma: PrismaService, jobs: RdJobsService, options: { redis?: string; enabled?: boolean; interval?: number; daily?: boolean } = {}): RdSchedulerService {
  const values: Record<string, unknown> = {
    REDIS_URL: options.redis === null ? undefined : options.redis ?? redisUrl,
    NODE_ENV: 'test',
    RD_RECONCILIATION_ENABLED: options.enabled ?? true,
    RD_RECONCILIATION_INTERVAL_MINUTES: options.interval ?? 60,
    RD_REFRESH_ENABLED: options.daily ?? false,
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
  const service = new RdSchedulerService(config, prisma, jobs, { refreshAll: vi.fn() } as unknown as RdAnalyticsService);
  services.push(service);
  return service;
}

function makeQueue(): Queue {
  return new Queue('rd-schedules', { connection: redisConnectionOptions(redisUrl!), prefix: `rd-insights-test-${process.pid}` });
}

function fakePrisma(accounts: Array<{ id: string; status: string; selected: boolean; available: boolean }>, afterPage?: () => void, failRecheckFor: string[] = []) {
  const eligible = new Map(accounts.map((account) => [account.id, account.status === 'active' || account.status === 'error' ? account.selected && account.available : false]));
  const findWhere: unknown[] = [];
  const prisma = {
    account: {
      findMany: vi.fn(async ({ where, take }: { where: { id?: { gt?: string } }; take: number }) => {
        const cursor = where.id?.gt ?? '';
        const page = accounts.filter((account) => account.id > cursor && eligible.get(account.id)).slice(0, take).map(({ id }) => ({ id }));
        afterPage?.();
        return page;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        findWhere.push(where);
        if (failRecheckFor.includes(where.id)) throw new Error('private details');
        return eligible.get(where.id) ? { id: where.id } : null;
      }),
    },
    rdConnection: { findUnique: vi.fn(async ({ where }: { where: { accountId: string } }) => {
      const account = accounts.find(({ id }) => id === where.accountId);
      return account ? { status: account.status, lastDeltaSyncAt: null } : null;
    }) },
    rdSegmentation: { count: vi.fn(async ({ where }: { where: { accountId: string } }) => Number(eligible.get(where.accountId) ?? false)) },
    syncRun: { findFirst: vi.fn(async () => null) },
  };
  return { prisma: prisma as unknown as PrismaService, findWhere, setEligible: (id: string, value: boolean) => eligible.set(id, value) };
}
