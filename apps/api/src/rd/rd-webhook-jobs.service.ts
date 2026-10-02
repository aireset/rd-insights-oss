import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { Env } from '../config/env.schema';
import { ConflictError, NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { redisConnectionOptions } from './rd-jobs.service';
import { RdWebhookProcessorService } from './rd-webhook-processor.service';

interface WebhookJob { accountId: string; logId: string }
const SAFE_ERROR = 'Falha ao processar evento RD. Tente novamente.';

@Injectable()
export class RdWebhookJobsService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly queue?: Queue<WebhookJob>;
  private readonly worker?: Worker<WebhookJob>;
  private timer?: ReturnType<typeof setInterval>;
  private recovering = false;
  private stopping = false;
  private ready = false;

  constructor(config: ConfigService<Env, true>, private readonly prisma: PrismaService, private readonly processor: RdWebhookProcessorService) {
    const url = config.get('REDIS_URL', { infer: true });
    if (!url) return;
    const connection = { ...redisConnectionOptions(url), connectTimeout: 2_000, enableOfflineQueue: false };
    const prefix = config.get('NODE_ENV', { infer: true }) === 'test' ? `rd-insights-test-${process.pid}` : 'rd-insights';
    this.queue = new Queue<WebhookJob>('rd-webhooks', { connection, prefix, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1_000 }, removeOnComplete: true, removeOnFail: { age: 604_800, count: 1_000 } } });
    this.worker = new Worker<WebhookJob>('rd-webhooks', (job) => this.process(job), { connection: { ...connection, enableOfflineQueue: true, maxRetriesPerRequest: null }, prefix, concurrency: 5 });
    this.queue.on('error', () => { this.ready = false; });
    this.worker.on('error', () => { this.ready = false; });
    this.worker.on('ready', () => { this.ready = true; void this.recover().catch(() => undefined); });
    this.worker.on('closed', () => { this.ready = false; });
  }

  onModuleInit(): void {
    if (!this.queue) return;
    // This only publishes durable rows; stable BullMQ IDs make multiple replicas safe.
    this.timer = setInterval(() => { void this.recover().catch(() => undefined); }, 30_000);
    this.timer.unref();
    void this.recover().catch(() => undefined);
  }

  async enqueue(accountId: string, logId: string): Promise<void> {
    if (!this.queue || this.stopping) throw new ServiceUnavailableException('Fila de eventos indisponível');
    const existing = await this.queue.getJob(`webhook-${logId}`);
    if (existing && await existing.getState() === 'failed') {
      await existing.retry();
      return;
    }
    await this.queue.add('webhook.process', { accountId, logId }, { jobId: `webhook-${logId}` });
  }

  async recover(): Promise<void> {
    if (!this.queue || this.recovering || this.stopping) return;
    this.recovering = true;
    try {
      // System outbox enumeration: identifiers only, processing is scoped by account.
      const rows = await this.prisma.webhookLog.findMany({ where: { status: 'pending' }, select: { id: true, accountId: true }, orderBy: { receivedAt: 'asc' }, take: 100 });
      for (const row of rows) await this.enqueue(row.accountId, row.id);
    } finally { this.recovering = false; }
  }

  private async process(job: Job<WebhookJob>): Promise<void> {
    const { accountId, logId: id } = job.data;
    const claimed = await this.prisma.webhookLog.updateMany({ where: { id, accountId, status: 'pending' }, data: { attempts: { increment: 1 } } });
    if (!claimed.count) return;
    const row = await this.prisma.webhookLog.findFirst({ where: { id, accountId, status: 'pending' }, select: { attempts: true } });
    if (!row) return;
    try {
      if (row.attempts > 5) throw new UnrecoverableError('Tentativas esgotadas');
      await this.processor.process(accountId, id);
    } catch {
      await this.prisma.webhookLog.updateMany({ where: { id, accountId, status: 'pending' }, data: { status: row.attempts >= 5 ? 'failed' : 'pending', lastError: SAFE_ERROR } });
      if (row.attempts >= 5) throw new UnrecoverableError('Falha ao processar evento RD');
      throw new Error('Falha ao processar evento RD');
    }
  }

  async retry(accountId: string, id: string): Promise<void> {
    const row = await this.prisma.webhookLog.findFirst({ where: { id, accountId, status: 'failed' }, select: { id: true } });
    if (!row) throw new NotFoundError('Evento com falha não encontrado');
    if (!this.queue || this.stopping) throw new ServiceUnavailableException('Fila de eventos indisponível');
    const job = await this.queue.getJob(`webhook-${id}`);
    if (job) {
      if (await job.getState() === 'active') throw new ConflictError('Evento ainda em processamento');
      await job.remove();
    }
    await this.prisma.webhookLog.updateMany({ where: { id, accountId, status: 'failed' }, data: { status: 'pending', attempts: 0, lastError: null } });
    // The durable reset survives a subsequent Redis failure.
    void this.enqueue(accountId, id).catch(() => undefined);
  }

  async status(accountId: string) {
    const [connection, pending, failed, lastReceived, lastProcessed, failures] = await Promise.all([
      this.prisma.rdConnection.findUnique({ where: { accountId }, select: { webhookRegisteredAt: true, webhookError: true, webhookUuids: true } }),
      this.prisma.webhookLog.count({ where: { accountId, status: 'pending' } }),
      this.prisma.webhookLog.count({ where: { accountId, status: 'failed' } }),
      this.prisma.webhookLog.findFirst({ where: { accountId }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
      this.prisma.webhookLog.findFirst({ where: { accountId, status: 'completed' }, orderBy: { processedAt: 'desc' }, select: { processedAt: true } }),
      this.prisma.webhookLog.findMany({ where: { accountId, status: 'failed' }, orderBy: { receivedAt: 'desc' }, take: 10, select: { id: true, eventType: true, receivedAt: true, attempts: true } }),
    ]);
    let running = false;
    try { running = this.ready && !!this.worker?.isRunning() && !this.stopping && !!this.queue && (await this.queue.getJobCounts()) !== undefined; } catch { /* safe state only */ }
    return { configured: connection?.webhookUuids.length === 2 && !!connection.webhookRegisteredAt, registeredAt: connection?.webhookRegisteredAt?.toISOString() ?? null, registrationError: connection?.webhookError ?? null, worker: running ? 'running' as const : 'stopped' as const, pending, failed, lastReceivedAt: lastReceived?.receivedAt.toISOString() ?? null, lastProcessedAt: lastProcessed?.processedAt?.toISOString() ?? null, failures: failures.map((f) => ({ ...f, receivedAt: f.receivedAt.toISOString() })) };
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
  }
}
