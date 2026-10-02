import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import type { RdWebhookProcessorService } from './rd-webhook-processor.service';
import { RdWebhookJobsService } from './rd-webhook-jobs.service';

const mock = vi.hoisted(() => ({ add: vi.fn(), getJob: vi.fn(), process: undefined as undefined | ((job: { data: { accountId: string; logId: string } }) => Promise<void>) }));
vi.mock('bullmq', async (load) => {
  const original = await load<typeof import('bullmq')>();
  return { ...original, Queue: class { add = mock.add; getJob = mock.getJob; on() {} async close() {} }, Worker: class { constructor(_name: string, processor: typeof mock.process) { mock.process = processor; } on() {} async close() {} isRunning() { return true; } } };
});
function fixture() {
  const db = { webhookLog: { findMany: vi.fn().mockResolvedValue([{ id: 'log', accountId: 'account' }]), findFirst: vi.fn().mockResolvedValue({ id: 'log', accountId: 'account', status: 'pending', attempts: 1 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  const processor = { process: vi.fn().mockResolvedValue(undefined) };
  const config = { get: (name: string) => name === 'REDIS_URL' ? 'redis://127.0.0.1:1' : 'test' };
  return { db, processor, svc: new RdWebhookJobsService(config as unknown as ConfigService<Env, true>, db as unknown as PrismaService, processor as unknown as RdWebhookProcessorService) };
}
describe('webhook outbox runtime', () => {
  beforeEach(() => { vi.clearAllMocks(); mock.add.mockResolvedValue({}); mock.getJob.mockResolvedValue(undefined); });
  it('recovers durable pending events with a stable job ID and account payload', async () => {
    const { svc, db } = fixture();
    await svc.recover();
    expect(db.webhookLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'pending' }, take: 100 }));
    expect(mock.add).toHaveBeenCalledWith('webhook.process', { accountId: 'account', logId: 'log' }, { jobId: 'webhook-log' });
  });
  it('processes via its own queue and counts persistent attempts before work', async () => {
    const { db, processor } = fixture();
    await mock.process!({ data: { accountId: 'account', logId: 'log' } });
    expect(db.webhookLog.updateMany).toHaveBeenCalledWith({ where: { id: 'log', accountId: 'account', status: 'pending' }, data: { attempts: { increment: 1 } } });
    expect(processor.process).toHaveBeenCalledWith('account', 'log');
  });
  it('recovers an exhausted Redis job whose database row remained pending during an outage', async () => {
    const { svc } = fixture();
    const retry = vi.fn().mockResolvedValue(undefined);
    mock.getJob.mockResolvedValue({ getState: async () => 'failed', retry });
    await svc.recover();
    expect(retry).toHaveBeenCalled();
  });
  it('marks the fifth failure terminal with a safe error, preserving retryable failures', async () => {
    const { db, processor } = fixture();
    db.webhookLog.findFirst.mockResolvedValue({ id: 'log', accountId: 'account', status: 'pending', attempts: 5 });
    processor.process.mockRejectedValue(new Error('private payload and token'));
    await expect(mock.process!({ data: { accountId: 'account', logId: 'log' } })).rejects.toThrow('Falha ao processar evento RD');
    expect(db.webhookLog.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { status: 'failed', lastError: 'Falha ao processar evento RD. Tente novamente.' } }));
  });
  it('does not process foreign or already completed IDs', async () => {
    const { db, processor } = fixture();
    db.webhookLog.updateMany.mockResolvedValue({ count: 0 });
    await mock.process!({ data: { accountId: 'other', logId: 'log' } });
    expect(processor.process).not.toHaveBeenCalled();
  });
  it('retry cannot target another account and only resets a terminal record', async () => {
    const { svc, db } = fixture();
    db.webhookLog.findFirst.mockResolvedValue(null as never);
    await expect(svc.retry('other', 'log')).rejects.toMatchObject({ status: 404 });
    expect(db.webhookLog.updateMany).not.toHaveBeenCalled();
  });
});
