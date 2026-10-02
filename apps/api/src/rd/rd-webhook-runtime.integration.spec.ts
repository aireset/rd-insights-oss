import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import { RdJobsService, redisConnectionOptions } from './rd-jobs.service';
import type { RdSyncService } from './rd-sync.service';
import type { RdRefreshService } from './rd-refresh.service';
import { RdWebhookService } from './rd-webhook.service';
import { RdWebhookJobsService } from './rd-webhook-jobs.service';
import { RdWebhookProcessorService } from './rd-webhook-processor.service';

const database = process.env.DATABASE_TEST_URL;
const redis = process.env.REDIS_TEST_URL;
describe.skipIf(!database || !redis)('durable webhook runtime with disposable Postgres/Redis', () => {
  const db = new PrismaClient({ datasources: { db: { url: database ?? 'postgresql://none:none@127.0.0.1:1/none' } } });
  const accountId = `webhook-runtime-${crypto.randomUUID()}`;
  const token = 'cd'.repeat(32);
  const config = { get: (key: string) => key === 'REDIS_URL' ? redis : 'test' } as unknown as ConfigService<Env, true>;
  const processor = new RdWebhookProcessorService(db as unknown as PrismaService);
  let runtime: RdWebhookJobsService;
  let scans: RdJobsService;
  let release: () => void;
  let refreshStarted = false;
  beforeAll(async () => {
    await db.account.create({ data: { id: accountId, name: 'Webhook fixture' } });
    await db.rdConnection.create({ data: { accountId, clientId: 'fixture', clientSecret: 'fixture', status: 'active', webhookTokenHash: createHash('sha256').update(token).digest('hex') } });
    await db.rdSegmentation.create({ data: { accountId, rdId: 'segment', name: 'Fixture', selected: true } });
  });
  afterAll(async () => {
    release?.();
    await scans?.beforeApplicationShutdown();
    await runtime?.beforeApplicationShutdown();
    const queue = new Queue('rd-webhooks', { connection: redisConnectionOptions(redis!), prefix: `rd-insights-test-${process.pid}` });
    await queue.obliterate({ force: true });
    await queue.close();
    await db.webhookLog.deleteMany({ where: { accountId } });
    await db.lead.deleteMany({ where: { accountId } });
    await db.syncRun.deleteMany({ where: { accountId } });
    await db.rdSegmentation.deleteMany({ where: { accountId } });
    await db.rdConnection.deleteMany({ where: { accountId } });
    await db.account.delete({ where: { id: accountId } });
    await db.$disconnect();
  });
  it('recovers after producer loss/restart and processes duplicate delivery while daily refresh is held', async () => {
    const block = new Promise<void>((resolve) => { release = resolve; });
    const refresh = { run: async (_account: string, id: string) => { refreshStarted = true; await block; await db.syncRun.update({ where: { id }, data: { status: 'completed', finishedAt: new Date() } }); } };
    scans = new RdJobsService(config, db as unknown as PrismaService, {} as RdSyncService, refresh as RdRefreshService);
    await scans.enqueueRefresh(accountId);
    await waitUntil(async () => refreshStarted);
    const unavailable = { enqueue: vi.fn().mockRejectedValue(new Error('Redis unavailable')) };
    const ingress = new RdWebhookService(db as unknown as PrismaService, unavailable as unknown as RdWebhookJobsService);
    const payload = { event_type: 'WEBHOOK.CONVERTED', entity_type: 'CONTACT', event_identifier: 'demo-form', event_timestamp: '2026-09-28T10:00:00Z', contact: { uuid: 'runtime-contact', name: 'Fictitious' } };
    const started = Date.now();
    await Promise.all([ingress.receive(accountId, token, payload), ingress.receive(accountId, token, { ...payload, timestamp: '2026-09-28T11:00:00Z' })]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await db.webhookLog.count({ where: { accountId } })).toBe(1);
    expect(await db.lead.count({ where: { accountId } })).toBe(0);
    runtime = new RdWebhookJobsService(config, db as unknown as PrismaService, processor);
    runtime.onModuleInit();
    await waitUntil(async () => (await db.webhookLog.count({ where: { accountId, status: 'completed' } })) === 1);
    expect(await db.syncRun.count({ where: { accountId, finishedAt: null } })).toBe(1);
    expect(await db.leadEvent.count({ where: { accountId } })).toBe(1);
    expect(await db.leadSegmentMembership.count({ where: { accountId } })).toBe(0);
    const status = await runtime.status(accountId);
    expect(status).toMatchObject({ pending: 0, failed: 0 });
    expect(JSON.stringify(status)).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain('Fictitious');
    release();
  });
  it('retries a terminal event within its account and clears the failure on completion', async () => {
    const event = await db.webhookLog.create({ data: { accountId, eventKey: 'manual-retry', eventType: 'WEBHOOK.MARKED_OPPORTUNITY', rdUuid: 'retry-contact', status: 'failed', attempts: 5, lastError: 'Falha anterior', payload: { event_type: 'WEBHOOK.MARKED_OPPORTUNITY', entity_type: 'CONTACT', event_identifier: 'default', event_timestamp: '2026-09-28T12:00:00Z', contact: { uuid: 'retry-contact' } } } });
    await expect(runtime.retry('another-account', event.id)).rejects.toMatchObject({ status: 404 });
    await runtime.retry(accountId, event.id);
    await waitUntil(async () => (await db.webhookLog.findUniqueOrThrow({ where: { id: event.id } })).status === 'completed');
    expect(await db.webhookLog.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ attempts: 1, lastError: null });
    expect(await db.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: 'retry-contact' } } })).toMatchObject({ opportunity: true, conversionsCount: 0 });
  });
});

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for isolated worker');
}
