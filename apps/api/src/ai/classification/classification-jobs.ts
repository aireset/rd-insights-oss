import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Queue, Worker } from 'bullmq';
import type { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { redisConnectionOptions } from '../../rd/rd-jobs.service';
import { ClassificationService } from './classification.service';

type Data = { accountId: string; taskId: string };
@Injectable()
export class ClassificationJobs implements OnModuleInit, BeforeApplicationShutdown {
  private readonly log = new Logger(ClassificationJobs.name);
  private readonly queue?: Queue<Data>;
  private readonly worker?: Worker<Data>;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private closing = false;
  constructor(@Inject(ConfigService) config: ConfigService<Env, true>, @Inject(PrismaService) private readonly prisma: PrismaService, @Inject(ClassificationService) private readonly service: ClassificationService) {
    const url = config.get('REDIS_URL', { infer: true });
    if (!url) return;
    const connection = redisConnectionOptions(url);
    const prefix = config.get('NODE_ENV', { infer: true }) === 'test' ? `rd-classification-test-${process.pid}` : 'rd-insights';
    this.queue = new Queue<Data>('ai-classification', { prefix, connection: { ...connection, enableOfflineQueue: false }, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: { count: 1000, age: 86400 } } });
    this.worker = new Worker<Data>('ai-classification', async (job, token) => {
      const delay = await this.service.process(job.data.accountId, job.data.taskId);
      if (delay) { await job.moveToDelayed(Date.now() + delay, token); throw new DelayedError(); }
    }, { prefix, connection: { ...connection, maxRetriesPerRequest: null }, concurrency: 5, autorun: false });
    this.queue.on('error', () => this.log.warn('Fila de classificação indisponível.'));
    this.worker.on('error', () => this.log.warn('Worker de classificação indisponível.'));
  }
  onModuleInit() {
    if (!this.worker) return;
    void this.worker.run().catch(() => undefined);
    this.timer = setInterval(() => void this.tick(), 30_000); this.timer.unref();
    void this.tick();
  }
  async tick(): Promise<void> {
    if (!this.queue || this.closing || this.ticking) return;
    this.ticking = true;
    try {
      await this.service.recoverUncertain();
      await this.service.discover();
      const tasks = await this.prisma.aiClassificationTask.findMany({ where: { status: 'pending', nextAttemptAt: { lte: new Date() } }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 100 });
      for (const task of tasks) {
        const jobId = `classification-${task.id}`;
        const old = await this.queue.getJob(jobId);
        if (old && await old.getState() === 'failed') await old.remove();
        await this.queue.add('classify', { accountId: task.accountId, taskId: task.id }, { jobId });
      }
    } catch { this.log.warn('Classificação pendente; dispatcher tentará novamente.'); }
    finally { this.ticking = false; }
  }
  async readiness() {
    if (!this.queue || !this.worker) return { redis: 'down', worker: 'stopped' };
    try { await this.queue.getJobCounts(); return { redis: 'up', worker: this.worker.isRunning() ? 'running' : 'stopped' }; }
    catch { return { redis: 'down', worker: 'stopped' }; }
  }
  async beforeApplicationShutdown() { this.closing = true; clearInterval(this.timer); await this.worker?.close(); await this.queue?.close(); }
}
