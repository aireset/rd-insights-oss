import { Injectable, Logger } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type { Env } from '../../config/env.schema';
import { redisConnectionOptions } from '../../common/redis-connection';
import { DailyInsightsService, INSIGHTS_TIMEZONE } from './daily-insights.service';

type Data = { accountId: string };
const QUEUE = 'ai-daily-insights';

@Injectable()
export class DailyInsightsJobs implements OnModuleInit, BeforeApplicationShutdown {
  private readonly log = new Logger(DailyInsightsJobs.name);
  private readonly queue?: Queue<Data>;
  private readonly worker?: Worker<Data>;

  constructor(config: ConfigService<Env, true>, service: DailyInsightsService) {
    const url = config.get('REDIS_URL', { infer: true });
    if (!url) return;
    const connection = redisConnectionOptions(url);
    const prefix = config.get('NODE_ENV', { infer: true }) === 'test' ? `rd-insights-test-${process.pid}` : 'rd-insights';
    this.queue = new Queue<Data>(QUEUE, { prefix, connection, defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 5_000 }, removeOnComplete: { age: 7 * 24 * 60 * 60 }, removeOnFail: { count: 1000, age: 7 * 24 * 60 * 60 } } });
    this.worker = new Worker<Data>(QUEUE, (job) => service.generate(job.data.accountId), { prefix, connection: { ...connection, maxRetriesPerRequest: null }, concurrency: 2, autorun: false });
    this.queue.on('error', () => this.log.warn('Fila de insights diários indisponível.'));
    this.worker.on('error', () => this.log.warn('Worker de insights diários indisponível.'));
  }

  onModuleInit(): void { void this.worker?.run().catch(() => undefined); }

  async enqueue(accountId: string): Promise<void> {
    if (!this.queue) return;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: INSIGHTS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    await this.queue.add('generate', { accountId }, { jobId: `daily-insight-${accountId}-${date}` });
  }

  async beforeApplicationShutdown(): Promise<void> { await this.worker?.close(); await this.queue?.close(); }
}
