import { Injectable, Logger } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RdConnectionStatus } from '@prisma/client';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { DailySyncView, DailyScheduleState, ReconciliationScheduleView, SegmentCoverageView } from '@rd/shared';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { RdJobsService, redisConnectionOptions } from './rd-jobs.service';
import { RdAnalyticsService } from './rd-analytics.service';

const QUEUE_NAME = 'rd-schedules';
const SCHEDULER_ID = 'rd-reconciliation-hourly';
const JOB_NAME = 'reconcile.tick';
const BATCH_SIZE = 100;
const ACTIVE_STATUSES = [RdConnectionStatus.active, RdConnectionStatus.error];

@Injectable()
export class RdSchedulerService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly log = new Logger(RdSchedulerService.name);
  private readonly enabled: boolean;
  private readonly dailyEnabled: boolean;
  private readonly intervalMinutes: number;
  private readonly queue?: Queue;
  private readonly worker?: Worker;
  private workerReady = false;
  private shutdown?: Promise<void>;

  constructor(config: ConfigService<Env, true>, private readonly prisma: PrismaService, private readonly jobs: RdJobsService, private readonly analytics: RdAnalyticsService) {
    this.enabled = config.get('RD_RECONCILIATION_ENABLED', { infer: true });
    this.dailyEnabled = config.get('RD_REFRESH_ENABLED', { infer: true }) ?? false;
    this.intervalMinutes = config.get('RD_RECONCILIATION_INTERVAL_MINUTES', { infer: true });
    const redisUrl = config.get('REDIS_URL', { infer: true });
    if (!redisUrl) return;
    const connection = redisConnectionOptions(redisUrl);
    const prefix = config.get('NODE_ENV', { infer: true }) === 'test' ? `rd-insights-test-${process.pid}` : 'rd-insights';
    this.queue = new Queue(QUEUE_NAME, { connection, prefix, defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 5_000 }, removeOnComplete: true, removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 } } });
    if (this.enabled || this.dailyEnabled) {
      this.worker = new Worker(QUEUE_NAME, (job) => {
        if (job.name === 'refresh.tick') return this.dispatch('refresh');
        if (job.name === 'catalog.tick') return this.dispatch('catalog');
        if (job.name === 'analytics.tick') return this.analytics.refreshAll();
        if (job.name !== JOB_NAME) throw new UnrecoverableError('Tipo de job de agendamento desconhecido');
        return this.dispatch();
      }, { connection: { ...connection, maxRetriesPerRequest: null }, prefix, concurrency: 1, autorun: false });
      this.worker.on('ready', () => { this.workerReady = true; });
      this.worker.on('closed', () => { this.workerReady = false; });
      this.worker.on('error', (error) => { this.workerReady = false; this.log.error(`worker Redis: ${error.name}`); });
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.queue) return;
    try {
      if (this.enabled) await this.queue.upsertJobScheduler(SCHEDULER_ID, { every: this.intervalMinutes * 60_000 }, {
        name: JOB_NAME,
        data: {},
        opts: { attempts: 3, backoff: { type: 'fixed', delay: 5_000 } },
      });
      else await this.queue.removeJobScheduler(SCHEDULER_ID);
      for (const [kind, pattern] of [['refresh', '0 0 2 * * *'], ['catalog', '0 30 1 * * *'], ['analytics', '0 0 4 * * *']] as const) {
        if (this.dailyEnabled) await this.queue.upsertJobScheduler(`rd-${kind}-daily`, { pattern, tz: 'America/Sao_Paulo' }, { name: `${kind}.tick`, data: {} });
        else await this.queue.removeJobScheduler(`rd-${kind}-daily`);
      }
      if (this.worker) {
        void this.worker.run().catch((error: unknown) => this.log.error(`worker Redis: ${error instanceof Error ? error.name : 'Error'}`));
        await this.worker.waitUntilReady();
      }
    } catch (error) {
      this.log.error(`scheduler Redis: ${error instanceof Error ? error.name : 'Error'}`);
    }
  }

  async dispatch(kind: 'delta' | 'refresh' | 'catalog' = 'delta'): Promise<void> {
    let cursor = '';
    let failures = 0;
    while (true) {
      const accounts = await this.prisma.account.findMany({
        where: { id: { gt: cursor }, rd: { is: { status: { in: ACTIVE_STATUSES } } }, ...(kind === 'catalog' ? {} : { segmentations: { some: { selected: true, available: true } } }) },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
      });
      if (!accounts.length) break;
      for (const { id: accountId } of accounts) {
        cursor = accountId;
        try {
          const eligible = await this.prisma.account.findFirst({
            where: { id: accountId, rd: { is: { status: { in: ACTIVE_STATUSES } } }, ...(kind === 'catalog' ? {} : { segmentations: { some: { selected: true, available: true } } }) },
            select: { id: true },
          });
          if (!eligible) continue;
          if (kind === 'refresh') await this.jobs.enqueueRefresh(accountId);
          else if (kind === 'catalog') await this.jobs.enqueueCatalog(accountId);
          else await this.jobs.enqueueReconciliation(accountId);
        } catch (error) {
          if (![409, 422].includes(exceptionStatus(error))) failures++;
        }
      }
      if (accounts.length < BATCH_SIZE) break;
    }
    if (failures) throw new Error('Falha ao reconciliar uma ou mais contas');
  }

  async coverage(accountId: string): Promise<SegmentCoverageView[]> {
    const segments = await this.prisma.rdSegmentation.findMany({ where: { accountId }, orderBy: [{ name: 'asc' }, { rdId: 'asc' }], select: { rdId: true, name: true, selected: true, available: true, coverage: true, lastScanAt: true, lastDeltaSyncAt: true } });
    return segments.map(({ rdId, lastScanAt, lastDeltaSyncAt, ...segment }) => ({ ...segment, id: rdId, lastScanAt: lastScanAt?.toISOString() ?? null, lastDeltaSyncAt: lastDeltaSyncAt?.toISOString() ?? null }));
  }

  async dailyStatus(accountId: string): Promise<DailySyncView> {
    const [connection, selected, run] = await Promise.all([
      this.prisma.rdConnection.findUnique({ where: { accountId } }),
      this.prisma.rdSegmentation.count({ where: { accountId, selected: true, available: true } }),
      this.prisma.syncRun.findFirst({ where: { accountId, kind: 'refresh' }, orderBy: { startedAt: 'desc' } }),
    ]);
    const eligible = !!connection && ['active', 'error'].includes(connection.status);
    const schedule = async (kind: 'refresh' | 'catalog', active: boolean): Promise<{ state: DailyScheduleState; nextRunAt: string | null }> => {
      if (!this.dailyEnabled) return { state: 'disabled', nextRunAt: null };
      if (!active) return { state: 'paused', nextRunAt: null };
      if (!this.queue || !this.worker || !this.workerReady || !this.worker.isRunning()) return { state: 'unavailable', nextRunAt: null };
      try {
        const job = await this.queue.getJobScheduler(`rd-${kind}-daily`);
        return job?.next ? { state: 'scheduled', nextRunAt: new Date(job.next).toISOString() } : { state: 'unavailable', nextRunAt: null };
      } catch { return { state: 'unavailable', nextRunAt: null }; }
    };
    const today = new Date(new Date().toISOString().slice(0, 10));
    const stats = (run?.stats ?? {}) as Record<string, unknown>;
    return {
      enabled: this.dailyEnabled,
      refresh: {
        ...await schedule('refresh', eligible && selected > 0), lastCompletedAt: connection?.lastRefreshAt?.toISOString() ?? null,
        budget: { limit: connection?.refreshDailyBudget ?? 1000, used: connection?.refreshBudgetDay && connection.refreshBudgetDay >= today ? connection.refreshRequestsUsed : 0, resetsAt: new Date(today.getTime() + 86_400_000).toISOString() },
        run: run ? { status: run.status, startedAt: run.startedAt.toISOString(), leadsCompleted: typeof stats.leadsCompleted === 'number' ? stats.leadsCompleted : 0, step: typeof stats.step === 'string' ? stats.step : null, page: typeof stats.page === 'number' ? stats.page : null, error: run.error } : null,
      },
      catalog: { ...await schedule('catalog', eligible), lastAttemptAt: connection?.catalogAttemptAt?.toISOString() ?? null, lastCompletedAt: connection?.catalogSyncedAt?.toISOString() ?? null, error: connection?.catalogError ?? null, budget: { limit: 100, used: connection?.catalogBudgetDay && connection.catalogBudgetDay >= today ? connection.catalogRequestsUsed : 0 } },
    };
  }

  async updateRefreshBudget(accountId: string, dailyBudget: number): Promise<void> {
    await this.prisma.rdConnection.update({ where: { accountId }, data: { refreshDailyBudget: dailyBudget } });
  }

  async status(accountId: string): Promise<ReconciliationScheduleView> {
    const [connection, segmentCount, attempt] = await Promise.all([
      this.prisma.rdConnection.findUnique({ where: { accountId }, select: { status: true, lastDeltaSyncAt: true } }),
      this.prisma.rdSegmentation.count({ where: { accountId, selected: true, available: true } }),
      this.prisma.syncRun.findFirst({ where: { accountId, kind: 'delta' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
    ]);
    const base = {
      enabled: this.enabled,
      intervalMinutes: this.intervalMinutes,
      lastAttemptAt: attempt?.startedAt.toISOString() ?? null,
      lastCompletedAt: connection?.lastDeltaSyncAt?.toISOString() ?? null,
    };
    if (!this.enabled) return { ...base, state: 'disabled', nextRunAt: null };
    if (!this.queue) return { ...base, state: 'unavailable', nextRunAt: null };
    if (!connection || (connection.status !== RdConnectionStatus.active && connection.status !== RdConnectionStatus.error) || !segmentCount) return { ...base, state: 'paused', nextRunAt: null };
    if (!this.worker || !this.workerReady || !this.worker.isRunning()) return { ...base, state: 'unavailable', nextRunAt: null };
    try {
      const scheduler = await this.queue.getJobScheduler(SCHEDULER_ID);
      if (!scheduler?.next) return { ...base, state: 'unavailable', nextRunAt: null };
      return { ...base, state: 'scheduled', nextRunAt: new Date(scheduler.next).toISOString() };
    } catch {
      return { ...base, state: 'unavailable', nextRunAt: null };
    }
  }

  beforeApplicationShutdown(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.shutdown = (async () => {
      try { await this.worker?.close(); }
      finally { await this.queue?.close(); }
    })();
    return this.shutdown;
  }
}

function exceptionStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'getStatus' in error && typeof error.getStatus === 'function') return error.getStatus();
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') return error.status;
  if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  return 0;
}
