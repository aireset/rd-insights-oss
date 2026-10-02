import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { Env } from '../config/env.schema';
import { BusinessError, ConflictError, NotFoundError, RdProviderError } from '../common/errors';
import type { SyncRunPage, SyncRunsQuery, SyncRunView } from '@rd/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RdSyncService, type Stats } from './rd-sync.service';
import { RdRefreshService } from './rd-refresh.service';
import { RdCatalogService } from './rd-catalog.service';
import { DailyInsightsJobs } from '../ai/llm/daily-insights.jobs';
import { redisConnectionOptions } from '../common/redis-connection';
export { redisConnectionOptions };

const QUEUE_NAME = 'rd-jobs';
const FULL_SYNC_JOB = 'sync.full';
const DELTA_SYNC_JOB = 'sync.delta';
const REFRESH_SYNC_JOB = 'sync.refresh';
const CATALOG_SYNC_JOB = 'sync.catalog';
const FULL_SYNC_JOB_ID = (accountId: string) => `rd-full-${accountDigest(accountId)}`;
const ACTIVE_STATES = new Set(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']);

type ScanKind = 'full' | 'delta' | 'refresh' | 'catalog';
interface RdJobData { accountId: string; runId?: string; runIds?: string[]; segmentIds?: string[]; kind?: ScanKind }
class QueueUnavailableError extends Error {}

@Injectable()
export class RdJobsService implements BeforeApplicationShutdown {
  private readonly log = new Logger(RdJobsService.name);
  private readonly queue?: Queue<RdJobData>;
  private readonly worker?: Worker<RdJobData>;
  private workerReady = false;
  private workerErrors = 0;
  private shuttingDown = false;
  private shutdown?: Promise<void>;

  constructor(config: ConfigService<Env, true>, private readonly prisma: PrismaService, private readonly sync: RdSyncService, @Optional() private readonly refresh?: RdRefreshService, @Optional() private readonly catalog?: RdCatalogService, @Optional() private readonly insights?: DailyInsightsJobs) {
    const redisUrl = config.get('REDIS_URL', { infer: true });
    if (!redisUrl) return;
    const connection = redisConnectionOptions(redisUrl);
    const prefix = config.get('NODE_ENV', { infer: true }) === 'test' ? `rd-insights-test-${process.pid}` : 'rd-insights';
    this.queue = new Queue<RdJobData>(QUEUE_NAME, { connection, prefix, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 } } });
    this.worker = new Worker<RdJobData>(QUEUE_NAME, (job) => this.process(job), { connection: { ...connection, maxRetriesPerRequest: null }, prefix, concurrency: 5, maxStalledCount: 5, autorun: false });
    this.worker.on('ready', () => { this.workerReady = true; });
    this.worker.on('closed', () => { this.workerReady = false; });
    this.worker.on('error', (error) => { this.workerErrors++; this.workerReady = false; this.log.error(`worker Redis: ${error.name}`); });
    this.worker.on('failed', (job) => {
      if (!job) return;
      void (async () => {
        if (await job.getState() !== 'failed') return;
        const ids = (job.data.runIds ?? [job.data.runId]).filter((id): id is string => !!id);
        await this.prisma.syncRun.updateMany({ where: { accountId: job.data.accountId, id: { in: ids }, finishedAt: null, status: { not: 'paused' } }, data: { status: 'partial', error: 'A fila interrompeu esta execução. Retome a sincronização para continuar do ponto salvo.' } });
      })().catch(() => this.log.warn('Não foi possível registrar a interrupção da fila.'));
    });
    void this.queue.removeGlobalConcurrency().then(() => {
      if (!this.shuttingDown) return this.worker!.run();
    }).catch(() => { this.workerReady = false; });
    const initialErrors = this.workerErrors;
    void this.worker.waitUntilReady().then(() => {
      if (this.workerErrors === initialErrors) this.workerReady = true;
    }).catch(() => undefined);
  }

  async enqueueFullSync(accountId: string, segmentIds?: string[]): Promise<{ runId: string; runIds: string[] }> {
    return this.enqueueSync(accountId, 'full', segmentIds);
  }

  async enqueueReconciliation(accountId: string): Promise<{ runId: string; runIds: string[] }> {
    return this.enqueueSync(accountId, 'delta');
  }

  async enqueueRefresh(accountId: string): Promise<{ runId: string; runIds: string[] }> {
    return this.enqueueSync(accountId, 'refresh');
  }

  async enqueueCatalog(accountId: string): Promise<{ runId: string; runIds: string[] }> {
    return this.enqueueSync(accountId, 'catalog');
  }

  private async enqueueSync(accountId: string, kind: ScanKind, segmentIds?: string[]): Promise<{ runId: string; runIds: string[] }> {
    const queue = this.queue;
    if (!queue || this.shuttingDown) throw new ServiceUnavailableException('Fila de sincronização indisponível');
    const jobId = FULL_SYNC_JOB_ID(accountId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`;
        if (kind !== 'full') {
          const connection = await tx.rdConnection.findUnique({ where: { accountId } });
          if (!connection || !['active', 'error'].includes(connection.status)) throw new ConflictError('A conexão RD precisa estar autorizada para reconciliar.');
        }
        const segments = await tx.rdSegmentation.findMany({ where: { accountId, selected: true, available: true, ...(segmentIds ? { rdId: { in: segmentIds } } : {}) }, orderBy: { rdId: 'asc' } });
        if (segmentIds && segments.length !== segmentIds.length) throw new NotFoundError('Segmentação não encontrada ou pausada');
        if (!segments.length && kind !== 'catalog') throw new BusinessError('Escolha uma segmentação antes de sincronizar');
        const selectedIds = segments.map((segment) => segment.rdId).sort();
        try {
          const existing = await queue.getJob(jobId);
          if (existing) {
            if (ACTIVE_STATES.has(await existing.getState()) && existing.data.runId) {
              if (kind === 'catalog' && (existing.data.kind ?? 'full') !== 'catalog') throw new ConflictError('Outra sincronização está em andamento. Aguarde a conclusão para atualizar o catálogo.');
              if (kind === 'full' && ((existing.data.kind ?? 'full') !== kind || JSON.stringify([...(existing.data.segmentIds ?? [])].sort()) !== JSON.stringify(selectedIds))) throw new ConflictError('Outra sincronização está em andamento. Aguarde a conclusão para iniciar esta seleção.');
              return { runId: existing.data.runId, runIds: existing.data.runIds ?? [existing.data.runId] };
            }
            await existing.remove();
          }
        } catch (error) {
          if (error instanceof ConflictError) throw error;
          throw new QueueUnavailableError();
        }
        const runs = await this.prepareRuns(tx, accountId, selectedIds, kind);
        const runIds = runs.map((run) => run.id);
        try {
          const name = { full: FULL_SYNC_JOB, delta: DELTA_SYNC_JOB, refresh: REFRESH_SYNC_JOB, catalog: CATALOG_SYNC_JOB }[kind];
          await queue.add(name, { accountId, runId: runIds[0], runIds, segmentIds: selectedIds, kind }, { jobId });
          return { runId: runIds[0], runIds };
        } catch { throw new QueueUnavailableError(); }
      });
    } catch (error) {
      if (!(error instanceof QueueUnavailableError)) throw error;
      await this.markQueueUnavailable(accountId, kind);
      throw new ServiceUnavailableException('Fila de sincronização indisponível');
    }
  }
  async readiness(): Promise<{ redis: 'up' | 'down'; worker: 'running' | 'stopped' }> {
    if (!this.queue || !this.worker) return { redis: 'down', worker: 'stopped' };
    try {
      await this.queue.getJobCounts();
      return { redis: 'up', worker: this.workerReady && this.worker.isRunning() && !this.shuttingDown ? 'running' : 'stopped' };
    } catch {
      return { redis: 'down', worker: this.workerReady && this.worker.isRunning() && !this.shuttingDown ? 'running' : 'stopped' };
    }
  }

  async status(accountId: string): Promise<SyncRunView | null> {
    const run = await this.sync.status(accountId);
    if (!run || !this.queue) return run;
    try {
      const job = await this.queue.getJob(FULL_SYNC_JOB_ID(accountId));
      const state = job ? await job.getState() : null;
      if (state === 'failed' && (job?.data.runIds ?? [job?.data.runId]).includes(run.id) && !run.finishedAt) return { ...run, status: 'partial', emAndamento: false, error: 'A fila interrompeu esta execução. Retome a sincronização para continuar do ponto salvo.' };
      return { ...run, emAndamento: run.emAndamento || (!!job && state !== null && ACTIVE_STATES.has(state)) };
    } catch {
      return run;
    }
  }

  async runs(accountId: string, query: SyncRunsQuery): Promise<SyncRunPage> {
    const queueStatuses = new Map<string, { status: 'queued' | 'running' | 'partial'; error?: string; emAndamento: boolean }>();
    if (!this.queue) return this.sync.runs(accountId, query, queueStatuses);
    try {
      const job = await this.queue.getJob(FULL_SYNC_JOB_ID(accountId));
      if (job) {
        const state = await job.getState();
        if (ACTIVE_STATES.has(state)) {
          const status = state === 'waiting' || state === 'delayed' || state === 'prioritized' ? 'queued' : 'running';
          for (const id of job.data.runIds ?? (job.data.runId ? [job.data.runId] : [])) queueStatuses.set(id, { status, emAndamento: true });
        } else if (state === 'failed') {
          const ids = job.data.runIds ?? (job.data.runId ? [job.data.runId] : []);
          const unfinished = await this.prisma.syncRun.findMany({ where: { accountId, id: { in: ids }, finishedAt: null }, select: { id: true } });
          for (const run of unfinished) queueStatuses.set(run.id, { status: 'partial', error: 'A fila interrompeu esta execução. Retome a sincronização para continuar do ponto salvo.', emAndamento: false });
        }
      }
    } catch { /* Keep persisted status if Redis is unavailable. */ }
    return this.sync.runs(accountId, query, queueStatuses);
  }

  beforeApplicationShutdown(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.shuttingDown = true;
    this.shutdown = (async () => {
      try { await this.worker?.close(); }
      finally { await this.queue?.close(); }
    })();
    return this.shutdown;
  }

  private async markQueueUnavailable(accountId: string, kind: ScanKind): Promise<void> {
    await this.prisma.syncRun.updateMany({ where: { accountId, kind, finishedAt: null }, data: { error: 'Fila Redis indisponível; reenvie a sincronização.' } }).catch(() => undefined);
  }

  private async prepareRuns(tx: Prisma.TransactionClient, accountId: string, segmentIds: string[], kind: ScanKind) {
      const runs = [];
      for (const segmentId of kind === 'refresh' || kind === 'catalog' ? [null] : segmentIds) {
        const run = await tx.syncRun.findFirst({ where: { accountId, segmentId, kind, finishedAt: null }, orderBy: { startedAt: 'desc' } });
        if (!run) runs.push(await tx.syncRun.create({ data: { accountId, segmentId, kind } }));
        else if (!run.error && run.status !== 'paused') runs.push(run);
        else {
          const stats = run.stats as Prisma.JsonObject;
          runs.push(await tx.syncRun.update({ where: { id: run.id, accountId }, data: { status: 'queued', error: null, stats: { ...stats, erros: 0, contactsFailed: 0 } } }));
        }
      }
      return runs;
  }

  private async process(job: Job<RdJobData>): Promise<void> {
    if (![FULL_SYNC_JOB, DELTA_SYNC_JOB, REFRESH_SYNC_JOB, CATALOG_SYNC_JOB].includes(job.name) || !job.data.runId) throw new UnrecoverableError('Tipo de job RD desconhecido');
    const kind = job.data.kind ?? (job.name === DELTA_SYNC_JOB ? 'delta' : 'full');
    let failure: unknown;
    for (const runId of job.data.runIds ?? [job.data.runId]) {
      const run = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${job.data.accountId}, 0))`;
        return tx.syncRun.findFirst({ where: { id: runId, accountId: job.data.accountId, kind } });
      });
      if (!run) throw new UnrecoverableError('Run de sincronização não encontrado');
      if (run.finishedAt || run.status === 'paused') continue;
      try {
        if (kind === 'refresh' || kind === 'catalog') {
          const service = kind === 'refresh' ? this.refresh : this.catalog;
          if (!service) throw new UnrecoverableError('Serviço de atualização indisponível');
          await service.run(job.data.accountId, run.id);
        }
        else if (run.segmentId) await this.sync.reconcileSegment(job.data.accountId, run.segmentId, run.id);
        else await this.sync.runFull(job.data.accountId, { fromCursor: run.cursor, runId: run.id, stats: run.stats as Partial<Stats> | null });
      } catch (error) {
        if (error instanceof RdProviderError && error.providerStatus && error.providerStatus >= 400 && error.providerStatus < 500 && ![408, 429].includes(error.providerStatus)) {
          const terminal = new UnrecoverableError(`RD exige ação do operador (${error.providerStatus})`);
          if (error.providerStatus === 401) {
            await this.prisma.syncRun.updateMany({ where: { accountId: job.data.accountId, finishedAt: null, status: 'queued' }, data: { status: 'paused', error: 'Autorize novamente a conexão RD para retomar.' } });
            throw terminal;
          }
          failure = terminal;
          continue;
        }
        failure ??= error;
      }
    }
    if (failure) throw failure;
    if (kind === 'refresh') {
      const runIds = (job.data.runIds ?? [job.data.runId]).filter((id): id is string => !!id);
      const completed = await this.prisma.syncRun.count({ where: { accountId: job.data.accountId, id: { in: runIds }, kind: 'refresh', status: 'completed' } });
      if (completed === runIds.length) await this.insights?.enqueue(job.data.accountId).catch(() => this.log.warn('Insights diários serão gerados após a próxima atualização.'));
      return;
    }
    if (kind === 'catalog') return;
    const pending = await this.prisma.syncRun.count({ where: { accountId: job.data.accountId, id: { in: job.data.runIds ?? [job.data.runId] }, finishedAt: null } });
    if (!pending) await this.prisma.rdConnection.updateMany({ where: { accountId: job.data.accountId }, data: { ...(kind === 'delta' ? { lastDeltaSyncAt: new Date() } : { lastFullSyncAt: new Date() }), status: 'active', lastError: null } });
  }
}

function accountDigest(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex');
}
