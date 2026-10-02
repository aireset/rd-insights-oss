import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import type { Worker } from 'bullmq';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.schema';
import { RdProviderError } from '../common/errors';
import { RdJobsService, redisConnectionOptions } from './rd-jobs.service';
import type { RdSyncService } from './rd-sync.service';
import type { RdRefreshService } from './rd-refresh.service';

const redisUrl = process.env.REDIS_TEST_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;
const services: RdJobsService[] = [];
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

describe('redisConnectionOptions', () => {
  it('parses TLS, database, and encoded ACL credentials without logging them', () => {
    const result = redisConnectionOptions('rediss://worker:p%40ss%3Aword@redis.example:6380/4');
    expect(result).toMatchObject({ host: 'redis.example', port: 6380, username: 'worker', password: 'p@ss:word', db: 4, tls: {}, maxRetriesPerRequest: 1 });
  });
});

describeWithRedis('RdJobsService', () => {
  it('routes refresh to its resumable scanner without marking full sync completion', async () => {
    const { prisma, rows, finish } = fakePrisma();
    const refresh = { run: vi.fn(async (_accountId: string, runId: string) => finish(runId)) };
    const jobs = makeService(prisma, { runFull: vi.fn() } as unknown as RdSyncService, refresh as unknown as RdRefreshService);
    services.push(jobs);
    const result = await jobs.enqueueRefresh(`refresh-${crypto.randomUUID()}`);
    await waitFor(() => rows.get(result.runId)?.finishedAt ?? null, 2_000);
    expect(refresh.run).toHaveBeenCalledTimes(1);
    expect(prisma.rdConnection.updateMany).not.toHaveBeenCalled();
  });

  it('queues the daily catalog even when no selected segment remains available', async () => {
    const { prisma, rows } = fakePrisma();
    vi.mocked(prisma.rdSegmentation.findMany).mockResolvedValue([]);
    const jobs = makeService(prisma, { runFull: vi.fn() } as unknown as RdSyncService);
    services.push(jobs);
    await (Reflect.get(jobs, 'worker') as Worker).pause();
    const result = await jobs.enqueueCatalog(`catalog-${crypto.randomUUID()}`);
    expect(rows.get(result.runId)).toMatchObject({ kind: 'catalog', segmentId: null });
  });

  it('prepares one refresh run for the account and reuses its checkpoint after a partial batch', async () => {
    const { prisma, rows, insert } = fakePrisma();
    const accountId = `refresh-${crypto.randomUUID()}`;
    insert({ id: 'refresh-pending', accountId, segmentId: null, kind: 'refresh', finishedAt: null, status: 'partial', cursor: 0, stats: { afterLeadId: 'lead-a', cutoffAt: '2026-09-28T00:00:00Z' }, error: 'budget' });
    const jobs = makeService(prisma, { runFull: vi.fn() } as unknown as RdSyncService);
    services.push(jobs);
    await (Reflect.get(jobs, 'worker') as Worker).pause();
    const result = await jobs.enqueueRefresh(accountId);
    expect(result).toEqual({ runId: 'refresh-pending', runIds: ['refresh-pending'] });
    expect(rows.size).toBe(1);
    expect(rows.get(result.runId)).toMatchObject({ segmentId: null, kind: 'refresh', status: 'queued', stats: { afterLeadId: 'lead-a' } });
  });

  it('coalesces refresh while the same connection has an active scan', async () => {
    const { prisma, rows } = fakePrisma();
    const jobs = makeService(prisma, { runFull: vi.fn() } as unknown as RdSyncService);
    services.push(jobs);
    await (Reflect.get(jobs, 'worker') as Worker).pause();
    const accountId = `refresh-${crypto.randomUUID()}`;
    const manual = await jobs.enqueueFullSync(accountId);
    expect(await jobs.enqueueRefresh(accountId)).toEqual(manual);
    expect(rows.size).toBe(1);
  });

  it('does not create delta runs while reauthorization is required', async () => {
    const { prisma, rows } = fakePrisma();
    vi.mocked(prisma.rdConnection.findUnique).mockResolvedValue({ status: 'reauth_required' } as never);
    const jobs = makeService(prisma, { runFull: vi.fn() } as unknown as RdSyncService);
    services.push(jobs);
    await expect(jobs.enqueueReconciliation(`delta-${crypto.randomUUID()}`)).rejects.toMatchObject({ status: 409 });
    expect(rows.size).toBe(0);
  });

  it('marks an existing delta checkpoint when queue publication fails without orphaning a new run', async () => {
    const { prisma, rows, insert } = fakePrisma();
    const accountId = `delta-${crypto.randomUUID()}`;
    insert({ id: 'pending-delta', accountId, segmentId: '9', kind: 'delta', finishedAt: null, status: 'queued', cursor: 2, stats: {}, error: null });
    const jobs = makeService(prisma, { runFull: vi.fn() } as unknown as RdSyncService);
    services.push(jobs);
    vi.spyOn(Reflect.get(jobs, 'queue') as Queue, 'add').mockRejectedValue(new Error('redis unavailable'));
    await expect(jobs.enqueueReconciliation(accountId)).rejects.toMatchObject({ status: 503 });
    expect(rows.size).toBe(1);
    expect(rows.get('pending-delta')).toMatchObject({ cursor: 2, finishedAt: null, error: 'Fila Redis indisponível; reenvie a sincronização.' });
  });

  it('queues a delta run and records only delta completion on the connection', async () => {
    const { prisma, rows, finish } = fakePrisma();
    const sync = { runFull: vi.fn(async (_id: string, opts: { runId: string }) => { finish(opts.runId); }) };
    const jobs = makeService(prisma, sync as unknown as RdSyncService);
    services.push(jobs);
    const response = await jobs.enqueueReconciliation(`delta-${crypto.randomUUID()}`);
    await waitFor(() => rows.get(response.runId)?.finishedAt ?? null, 2_000);
    expect(rows.get(response.runId)?.kind).toBe('delta');
    expect(prisma.rdConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastDeltaSyncAt: expect.any(Date) }) }));
    expect(prisma.rdConnection.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastFullSyncAt: expect.anything() }) }));
  });

  it('coalesces scheduled reconciliation with an active manual load', async () => {
    const { prisma, rows, finish } = fakePrisma();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sync = { runFull: vi.fn(async (_id: string, opts: { runId: string }) => { await gate; finish(opts.runId); }) };
    const jobs = makeService(prisma, sync as unknown as RdSyncService);
    services.push(jobs);
    const id = `delta-${crypto.randomUUID()}`;
    try {
      const manual = await jobs.enqueueFullSync(id);
      expect(await jobs.enqueueReconciliation(id)).toEqual(manual);
      expect(rows.size).toBe(1);
    } finally { release(); }
  });

  it('does not advance the account delta watermark when a segment pauses before completion', async () => {
    const { prisma, rows } = fakePrisma();
    vi.mocked(prisma.syncRun.count).mockResolvedValue(1);
    const sync = { runFull: vi.fn(async (_id: string, opts: { runId: string }) => { rows.get(opts.runId)!.status = 'paused'; }) };
    const jobs = makeService(prisma, sync as unknown as RdSyncService);
    services.push(jobs);
    const queue = Reflect.get(jobs, 'queue') as Queue;
    const accountId = `delta-${crypto.randomUUID()}`;
    const queued = await jobs.enqueueReconciliation(accountId);
    await waitFor(async () => rows.get(queued.runId)?.status === 'paused' && !(await queue.getJob(`rd-full-${createHash('sha256').update(accountId).digest('hex')}`)), 2_000);
    expect(rows.get(queued.runId)?.finishedAt).toBeNull();
    expect(prisma.rdConnection.updateMany).not.toHaveBeenCalled();
  });

  it('runs different accounts in parallel on one API instance', async () => {
    const { prisma, finish } = fakePrisma();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startedAccounts = new Set<string>();
    let active = 0;
    let maximum = 0;
    const sync = { runFull: vi.fn(async (accountId: string, opts: { runId: string }) => {
      maximum = Math.max(maximum, ++active);
      startedAccounts.add(accountId);
      await gate;
      finish(opts.runId);
      active--;
    }) };
    const jobs = makeService(prisma, sync as unknown as RdSyncService);
    services.push(jobs);
    const accountA = `account-${crypto.randomUUID()}`;
    const accountB = `account-${crypto.randomUUID()}`;

    try {
      await Promise.all([jobs.enqueueFullSync(accountA), jobs.enqueueFullSync(accountB)]);
      await waitFor(() => startedAccounts.size === 2 ? true : null, 2_000);
      expect(startedAccounts).toEqual(new Set([accountA, accountB]));
      expect(maximum).toBe(2);
    } finally {
      release();
    }
  }, 10_000);

  it('coalesces concurrent requests from two API instances into one account job', async () => {
    const { prisma, finish } = fakePrisma();
    let started!: () => void;
    let release!: () => void;
    const runStarted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sync = { runFull: vi.fn(async (_accountId: string, opts: { runId: string }) => { started(); await gate; finish(opts.runId); }) };
    const first = makeService(prisma, sync as unknown as RdSyncService);
    const second = makeService(prisma, sync as unknown as RdSyncService);
    services.push(first, second);
    const accountId = `account-${crypto.randomUUID()}`;

    try {
      const results = await Promise.all([first.enqueueFullSync(accountId), second.enqueueFullSync(accountId)]);
      await runStarted;
      expect(results[0]).toEqual(results[1]);
      expect(sync.runFull).toHaveBeenCalledTimes(1);
    const inspect = makeQueue();
    queues.push(inspect);
    expect(await inspect.getJob(`rd-full-${accountId}`)).toBeUndefined();
    const jobId = `rd-full-${createHash('sha256').update(accountId).digest('hex')}`;
    expect((await inspect.getJob(jobId))?.data.runIds).toEqual(results[0].runIds);
    } finally {
      release();
    }
  });

  it('does not disguise database failures as Redis outages', async () => {
    const { prisma } = fakePrisma();
    const failure = new Error('database unavailable');
    vi.spyOn(prisma, '$transaction').mockRejectedValue(failure);
    const jobs = makeService(prisma, { runFull: vi.fn() } as unknown as RdSyncService);
    services.push(jobs);

    await expect(jobs.enqueueFullSync(`account-${crypto.randomUUID()}`)).rejects.toBe(failure);
    expect(prisma.syncRun.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back a newly prepared run when Redis rejects queue.add', async () => {
    const { prisma, rows } = fakePrisma();
    const jobs = makeService(prisma, { runFull: vi.fn() } as unknown as RdSyncService);
    services.push(jobs);
    const queue = Reflect.get(jobs, 'queue') as Queue;
    vi.spyOn(queue, 'add').mockRejectedValue(new Error('redis unavailable'));

    await expect(jobs.enqueueFullSync(`account-${crypto.randomUUID()}`)).rejects.toMatchObject({ status: 503 });
    expect(rows.size).toBe(0);
  });

  it('reports a stopped worker as unavailable while Redis itself is up', async () => {
    const { prisma } = fakePrisma();
    const jobs = makeService(prisma, { runFull: vi.fn() } as unknown as RdSyncService);
    services.push(jobs);
    const worker = Reflect.get(jobs, 'worker') as Worker;
    await worker.waitUntilReady();
    expect(await jobs.readiness()).toEqual({ redis: 'up', worker: 'running' });

    await worker.close();

    expect(await jobs.readiness()).toEqual({ redis: 'up', worker: 'stopped' });
  });

  it('waits for active sync work before shutting down the worker', async () => {
    const { prisma, rows, finish } = fakePrisma();
    let started!: () => void;
    let release!: () => void;
    const runStarted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sync = { runFull: vi.fn(async (_accountId: string, opts: { runId: string }) => { started(); await gate; finish(opts.runId); }) };
    const jobs = makeService(prisma, sync as unknown as RdSyncService);
    services.push(jobs);
    const { runId } = await jobs.enqueueFullSync(`account-${crypto.randomUUID()}`);
    await runStarted;
    let closed = false;
    const closing = jobs.beforeApplicationShutdown().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toBe(false);

    release();
    await closing;

    expect(rows.get(runId)?.finishedAt).toBeInstanceOf(Date);
  }, 15_000);

  it('retries a 429 after backoff and completes the same persisted run', async () => {
    const { prisma, rows, finish } = fakePrisma();
    let attempts = 0;
    const sync = { runFull: vi.fn(async (_accountId: string, opts: { runId: string }) => {
      attempts++;
      if (attempts === 1) throw new RdProviderError('RD respondeu 429', 429);
      finish(opts.runId);
    }) };
    const jobs = makeService(prisma, sync as unknown as RdSyncService);
    services.push(jobs);
    const accountId = `account-${crypto.randomUUID()}`;

    const queued = await jobs.enqueueFullSync(accountId);
    await waitFor(() => attempts === 2, 12_000);

    expect(sync.runFull).toHaveBeenCalledTimes(2);
    expect(rows.get(queued.runId)?.finishedAt).toBeInstanceOf(Date);
  }, 15_000);

  it('retries a 503 with backoff', async () => {
    const { prisma, rows, finish } = fakePrisma();
    let attempts = 0;
    let firstAttemptAt = 0;
    let secondAttemptAt = 0;
    const sync = { runFull: vi.fn(async (_accountId: string, opts: { runId: string }) => {
      attempts++;
      if (attempts === 1) { firstAttemptAt = Date.now(); throw new RdProviderError('RD respondeu 503', 503); }
      secondAttemptAt = Date.now();
      finish(opts.runId);
    }) };
    const jobs = makeService(prisma, sync as unknown as RdSyncService);
    services.push(jobs);
    const queued = await jobs.enqueueFullSync(`account-${crypto.randomUUID()}`);

    await waitFor(() => attempts === 2, 12_000);

    expect(attempts).toBe(2);
    expect(secondAttemptAt - firstAttemptAt).toBeGreaterThanOrEqual(4_000);
    expect(rows.get(queued.runId)?.finishedAt).toBeInstanceOf(Date);
  }, 15_000);

  it('marks an expired RD authorization as non-retryable', async () => {
    const { prisma } = fakePrisma();
    const sync = { runFull: vi.fn(async () => { throw new RdProviderError('RD respondeu 401', 401); }) };
    const jobs = makeService(prisma, sync as unknown as RdSyncService);
    services.push(jobs);
    const inspect = makeQueue();
    const accountId = `account-${crypto.randomUUID()}`;
    await jobs.enqueueFullSync(accountId);
    const jobId = `rd-full-${createHash('sha256').update(accountId).digest('hex')}`;
    const job = await waitFor(async () => {
      const current = await inspect.getJob(jobId);
      return current && await current.getState() === 'failed' ? current : null;
    }, 10_000);

    expect(sync.runFull).toHaveBeenCalledTimes(1);
    expect(await job.getState()).toBe('failed');
  });

  it('restores a waiting job after the producer process has closed', async () => {
    const accountId = `account-${crypto.randomUUID()}`;
    const runId = `run-${crypto.randomUUID()}`;
    const { prisma, rows, insert } = fakePrisma();
    insert({ id: runId, accountId, kind: 'full', startedAt: new Date(), finishedAt: null, cursor: 2, stats: { phase: 'history' }, error: null });
    const queue = makeQueue();
    queues.push(queue);
    await queue.add('sync.full', { accountId, runId }, { jobId: `rd-full-${accountId}` });
    await queue.close();
    queues.pop();
    let sync!: { runFull: ReturnType<typeof vi.fn> };
    const finished = new Promise<void>((resolve, reject) => {
      sync = { runFull: vi.fn(async (_id: string, opts: { fromCursor: number; runId: string; stats: unknown }) => {
        expect(opts).toMatchObject({ fromCursor: 2, runId, stats: { phase: 'history' } });
        rows.get(runId)!.finishedAt = new Date();
        resolve();
      }) };
      const service = makeService(prisma, sync as unknown as RdSyncService);
      const worker = Reflect.get(service, 'worker') as Worker;
      worker.on('failed', (_job, error) => reject(error));
      services.push(service);
    });

    await (Reflect.get(services.at(-1)!, 'worker') as Worker).waitUntilReady();
    await finished;
  }, 15_000);
});

describe('RdJobsService without Redis', () => {
  it('reports both Redis and worker unavailable', async () => {
    const { prisma } = fakePrisma();
    const jobs = new RdJobsService({ get: () => undefined } as unknown as ConfigService<Env, true>, prisma, { runFull: vi.fn() } as unknown as RdSyncService);

    expect(await jobs.readiness()).toEqual({ redis: 'down', worker: 'stopped' });
    await jobs.beforeApplicationShutdown();
  });
});

function makeService(prisma: ReturnType<typeof fakePrisma>['prisma'], sync: RdSyncService, refresh?: RdRefreshService): RdJobsService {
  sync.reconcileSegment = async (accountId, _segmentId, runId) => {
    const run = await prisma.syncRun.findFirstOrThrow({ where: { id: runId } });
    return sync.runFull(accountId, { runId, fromCursor: run.cursor, stats: run.stats as never });
  };
  return new RdJobsService({ get: (key: string) => key === 'REDIS_URL' ? redisUrl : 'test' } as unknown as ConfigService<Env, true>, prisma, sync, refresh);
}

function makeQueue(): Queue<{ accountId: string; runId: string }> {
  return new Queue('rd-jobs', { connection: redisConnectionOptions(redisUrl!), prefix: `rd-insights-test-${process.pid}` });
}

function fakePrisma() {
  const rows = new Map<string, Record<string, unknown>>();
  let nextId = 0;
  let tail = Promise.resolve();
  const find = async (where: Record<string, unknown>) => [...rows.values()].find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null;
  const syncRun = {
    count: vi.fn(async () => 0),
    findFirst: vi.fn(({ where }: { where: Record<string, unknown> }) => find(where)),
    findFirstOrThrow: vi.fn(({ where }: { where: Record<string, unknown> }) => find(where)),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `run-${++nextId}`, startedAt: new Date(), finishedAt: null, cursor: 0, stats: {}, error: null, ...data };
      rows.set(String(row.id), row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.get(where.id)!;
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      for (const row of rows.values()) if (Object.entries(where).every(([key, value]) => row[key] === value)) Object.assign(row, data);
      return { count: rows.size };
    }),
  };
  const rdSegmentation = { count: vi.fn(async () => 1), findMany: vi.fn(async ({ where }: { where: { rdId?: { in: string[] } } }) => (where.rdId?.in ?? ['9']).map((rdId) => ({ rdId }))) };
  const rdConnection = { findUnique: vi.fn(async () => ({ status: 'active' })), updateMany: vi.fn(async () => ({ count: 1 })) };
  const tx = { $executeRaw: vi.fn(async () => 1), syncRun, rdSegmentation, rdConnection };
  const prisma = {
    syncRun,
    rdSegmentation,
    rdConnection,
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const snapshot = new Map([...rows].map(([id, row]) => [id, { ...row }]));
      const startingId = nextId;
      try { return await fn(tx); } catch (error) {
        rows.clear();
        for (const [id, row] of snapshot) rows.set(id, row);
        nextId = startingId;
        throw error;
      } finally { release(); }
    },
  } as unknown as PrismaService;
  return { prisma, rows, insert: (row: Record<string, unknown>) => rows.set(String(row.id), row), finish: (id: string) => { rows.get(id)!.finishedAt = new Date(); } };
}

async function waitFor<T>(check: () => Promise<T | null> | T | null, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}
