import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ClassificationJobs } from './classification-jobs';
import { ClassificationService } from './classification.service';
import type { PrismaService } from '../../prisma/prisma.service';

describe.skipIf(!process.env.DATABASE_TEST_URL || !process.env.REDIS_TEST_URL)('classification Redis outbox', () => {
  const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
  const accounts: string[] = [];
  afterAll(async () => { await db.lead.deleteMany({ where: { accountId: { in: accounts } } }); await db.account.deleteMany({ where: { id: { in: accounts } } }); await db.$disconnect(); });
  it('recovers persisted tasks after producer restart and coalesces duplicate publications', async () => {
    const accountId = randomUUID(); accounts.push(accountId);
    await db.account.create({ data: { id: accountId, name: 'Queue test' } });
    const lead = await db.lead.create({ data: { accountId, rdUuid: randomUUID() } });
    await db.aiConfig.create({ data: { accountId, enabled: true, model: 'mock', apiKey: 'mock' } });
    const provider = vi.fn().mockResolvedValue({ content: '{"score":"frio","reason":"Parcial","summary":"Sem eventos"}', inputTokens: 10, outputTokens: 20, costMicros: null });
    const service = new ClassificationService(db as PrismaService, provider);
    await service.savePolicy(accountId, { inputUsdPerMillion: '1', outputUsdPerMillion: '1' });
    const task = await service.enqueue(accountId, lead.id, 'initial');
    const jobs = new ClassificationJobs(new ConfigService({ REDIS_URL: process.env.REDIS_TEST_URL, NODE_ENV: 'test' }), db as PrismaService, service);
    try {
      jobs.onModuleInit();
      await Promise.all([jobs.tick(), jobs.tick(), jobs.tick()]);
      await vi.waitFor(async () => expect((await db.aiClassificationTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('completed'), { timeout: 10_000 });
      expect(provider).toHaveBeenCalledTimes(1);
    } finally { await jobs.beforeApplicationShutdown(); }
  });
});
