import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClassificationService } from './classification.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { ProviderFailure } from './provider-fetch';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('classification durable budget and canonical deduplication', () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const accounts: string[] = [];
  const answer = { content: JSON.stringify({ score: 'morno', reason: 'Dados parciais', summary: 'Duas conversões importadas' }), inputTokens: 100, outputTokens: 50, costMicros: null };
  const provider = vi.fn().mockResolvedValue(answer);
  const service = new ClassificationService(db as PrismaService, provider);
  async function setup(budget = 1000, rate = 10) {
    const accountId = randomUUID(); accounts.push(accountId);
    await db.account.create({ data: { id: accountId, name: 'Classification test' } });
    await db.aiConfig.create({ data: { accountId, model: 'mock', apiKey: 'mock-key', enabled: true, monthlyBudgetCents: budget, requestsPerMinute: rate } });
    const lead = await db.lead.create({ data: { accountId, rdUuid: randomUUID(), conversionsCount: 2, aiScore: 'frio', aiSummary: 'Anterior' } });
    await service.savePolicy(accountId, { inputUsdPerMillion: '1.00', outputUsdPerMillion: '2.00' });
    return { accountId, lead };
  }
  beforeAll(() => db.$connect());
  afterAll(async () => { await db.lead.deleteMany({ where: { accountId: { in: accounts } } }); await db.account.deleteMany({ where: { id: { in: accounts } } }); await db.$disconnect(); });
  it('coalesces concurrent enqueue and logs one token-priced canonical result', async () => {
    const { accountId, lead } = await setup();
    const tasks = await Promise.all(Array.from({ length: 5 }, () => service.enqueue(accountId, lead.id, 'initial')));
    expect(new Set(tasks.map((t) => t.id)).size).toBe(1);
    await Promise.all(tasks.map((t) => service.process(accountId, t.id)));
    const result = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(result.aiScore).toBe('morno');
    const logs = await db.aiLog.findMany({ where: { accountId } });
    expect(logs).toHaveLength(1); expect(logs[0]?.costMicros).toBe(200n);
    expect(JSON.stringify(logs, (_, v) => typeof v === 'bigint' ? v.toString() : v)).not.toContain('Dados parciais');
  });
  it('fails closed without prices and preserves previous classification for invalid JSON', async () => {
    const { accountId, lead } = await setup();
    await db.aiClassificationPolicy.delete({ where: { accountId } });
    const task = await service.enqueue(accountId, lead.id, 'initial');
    const calls = provider.mock.calls.length;
    await service.process(accountId, task.id);
    expect(provider.mock.calls.length).toBe(calls);
    expect((await service.leadStatus(accountId, lead.id)).error).toContain('preços');
    await service.savePolicy(accountId, { inputUsdPerMillion: '1', outputUsdPerMillion: '2' });
    expect((await service.leadStatus(accountId, lead.id)).status).toBe('pending');
    provider.mockResolvedValueOnce({ ...answer, content: 'invalid' });
    await service.retry(accountId, lead.id);
    await service.process(accountId, task.id);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).aiSummary).toBe('Anterior');
    expect(await db.aiLog.count({ where: { accountId } })).toBe(1);
  });
  it('serializes per-account reservations/rate before HTTP, while another account can proceed', async () => {
    const a = await setup(1000, 1); const b = await setup(1000, 1);
    const lead2 = await db.lead.create({ data: { accountId: a.accountId, rdUuid: randomUUID() } });
    const t1 = await service.enqueue(a.accountId, a.lead.id, 'initial');
    const t2 = await service.enqueue(a.accountId, lead2.id, 'initial');
    const t3 = await service.enqueue(b.accountId, b.lead.id, 'initial');
    const responses = await Promise.all([service.process(a.accountId, t1.id), service.process(a.accountId, t2.id), service.process(b.accountId, t3.id)]);
    expect(responses.filter((v) => typeof v === 'number')).toHaveLength(1);
    expect(await db.aiClassificationAttempt.count({ where: { accountId: a.accountId } })).toBe(1);
    expect(await db.aiLog.count({ where: { accountId: b.accountId } })).toBe(1);
  });
  it('holds unknown cost after timeout and never automatically repeats an ambiguous call', async () => {
    const { accountId, lead } = await setup();
    const task = await service.enqueue(accountId, lead.id, 'initial');
    provider.mockRejectedValueOnce(new Error('secret provider body'));
    await service.process(accountId, task.id);
    const calls = provider.mock.calls.length;
    await service.process(accountId, task.id);
    expect(provider.mock.calls.length).toBe(calls);
    const attempt = await db.aiClassificationAttempt.findFirstOrThrow({ where: { accountId } });
    expect(attempt.chargedMicros).toBe(attempt.reservedMicros);
    expect((await service.leadStatus(accountId, lead.id)).error).not.toContain('secret');
  });
  it('prevents stale result from replacing a lead changed during HTTP', async () => {
    const { accountId, lead } = await setup();
    const task = await service.enqueue(accountId, lead.id, 'initial');
    provider.mockImplementationOnce(async () => { await db.lead.update({ where: { id: lead.id }, data: { conversionsCount: 3 } }); return answer; });
    await service.process(accountId, task.id);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).aiSummary).toBe('Anterior');
    expect((await service.leadStatus(accountId, lead.id)).status).toBe('superseded');
  });
  it('rejects cross-account reads and budget exhaustion without calling the provider', async () => {
    const a = await setup(1); const b = await setup();
    await expect(service.leadStatus(b.accountId, a.lead.id)).rejects.toThrow('Lead não encontrado');
    await service.savePolicy(a.accountId, { inputUsdPerMillion: '1000', outputUsdPerMillion: '1000' });
    const task = await service.enqueue(a.accountId, a.lead.id, 'initial');
    const calls = provider.mock.calls.length;
    await service.process(a.accountId, task.id);
    expect(provider.mock.calls.length).toBe(calls);
    expect((await service.leadStatus(a.accountId, a.lead.id)).error).toContain('Orçamento');
  });
  it('finds late historical events and never duplicates a lead present in two memberships', async () => {
    const { accountId, lead } = await setup();
    for (const rdId of ['one', 'two']) {
      await db.rdSegmentation.create({ data: { accountId, rdId, name: rdId, selected: true } });
      await db.leadSegmentMembership.create({ data: { accountId, segmentationRdId: rdId, leadRdUuid: lead.rdUuid } });
    }
    await service.discover();
    expect(await db.aiClassificationTask.count({ where: { accountId } })).toBe(1);
    await service.discover();
    expect(await db.aiClassificationTask.count({ where: { accountId } })).toBe(1);
    await db.leadEvent.create({ data: { accountId, leadId: lead.id, type: 'CONVERSION', identifier: 'late', occurredAt: new Date('2020-01-01') } });
    await service.discover();
    const tasks = await db.aiClassificationTask.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
    expect(tasks).toHaveLength(2); expect(tasks[1]?.source).toBe('conversion');
    await db.leadSegmentMembership.deleteMany({ where: { accountId } });
  });
  it('keeps a shared budget reservation while HTTP runs and lets another account progress', async () => {
    const a = await setup(1); const b = await setup();
    await service.savePolicy(a.accountId, { inputUsdPerMillion: '2', outputUsdPerMillion: '2' });
    const other = await db.lead.create({ data: { accountId: a.accountId, rdUuid: randomUUID() } });
    const t1 = await service.enqueue(a.accountId, a.lead.id, 'initial');
    const t2 = await service.enqueue(a.accountId, other.id, 'initial');
    const t3 = await service.enqueue(b.accountId, b.lead.id, 'initial');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    provider.mockImplementationOnce(async () => { started = true; await gate; return answer; });
    const first = service.process(a.accountId, t1.id);
    await vi.waitFor(() => expect(started).toBe(true));
    try {
      await service.process(a.accountId, t2.id);
      await service.process(b.accountId, t3.id);
      expect((await service.leadStatus(a.accountId, other.id)).error).toContain('Orçamento');
      expect((await service.leadStatus(b.accountId, b.lead.id)).status).toBe('completed');
    } finally { release(); await first; }
  });
  it('persists account backpressure and preserves uncertain crash reservations', async () => {
    const { accountId, lead } = await setup();
    const task = await service.enqueue(accountId, lead.id, 'initial');
    provider.mockRejectedValueOnce(new ProviderFailure('rate_limit', 5000));
    expect(await service.process(accountId, task.id)).toBe(5000);
    expect((await service.getPolicy(accountId)).cooldownUntil).not.toBeNull();
    expect((await service.leadStatus(accountId, lead.id)).status).toBe('pending');
    await db.aiClassificationTask.update({ where: { id: task.id }, data: { status: 'processing', updatedAt: new Date(Date.now() - 360000) } });
    await service.recoverUncertain();
    expect((await service.leadStatus(accountId, lead.id)).status).toBe('failed');
  });
  it('invalidates in-flight output and completed deduplication when the endpoint changes', async () => {
    const { accountId, lead } = await setup();
    const task = await service.enqueue(accountId, lead.id, 'initial');
    provider.mockImplementationOnce(async () => { await db.aiConfig.update({ where: { accountId }, data: { baseUrl: 'https://other.example.test/v1' } }); return answer; });
    await service.process(accountId, task.id);
    expect((await service.leadStatus(accountId, lead.id)).status).toBe('superseded');
    expect((await service.enqueue(accountId, lead.id, 'refresh')).id).not.toBe(task.id);
  });
  it('never shortens a cooldown already set by a concurrent provider response', async () => {
    const { accountId, lead } = await setup();
    const task = await service.enqueue(accountId, lead.id, 'initial');
    const longer = new Date(Date.now() + 120_000);
    provider.mockImplementationOnce(async () => { await db.aiClassificationPolicy.update({ where: { accountId }, data: { cooldownUntil: longer } }); throw new ProviderFailure('rate_limit', 5000); });
    await service.process(accountId, task.id);
    expect(new Date((await service.getPolicy(accountId)).cooldownUntil!).getTime()).toBeGreaterThanOrEqual(longer.getTime());
  });
  it('distribuição e "classificar todos" respeitam a conta e só enfileiram leads sem classificação', async () => {
    const a = await setup(); const b = await setup();
    await db.lead.update({ where: { id: a.lead.id }, data: { aiScore: 'quente' } });
    const un1 = await db.lead.create({ data: { accountId: a.accountId, rdUuid: randomUUID() } });
    await db.lead.create({ data: { accountId: a.accountId, rdUuid: randomUUID() } });
    expect(await service.distribution(a.accountId)).toMatchObject({ configured: true, total: 3, quente: 1, morno: 0, frio: 0, semClassificacao: 2 });
    expect(await service.distribution(b.accountId)).toMatchObject({ total: 1, frio: 1, semClassificacao: 0 });
    const r = await service.enqueueUnclassified(a.accountId);
    expect(r).toMatchObject({ total: 2, started: true });
    await vi.waitFor(async () => expect(await db.aiClassificationTask.count({ where: { accountId: a.accountId } })).toBe(2));
    expect(await db.aiClassificationTask.count({ where: { accountId: b.accountId } })).toBe(0);
    expect(await db.aiClassificationTask.count({ where: { accountId: a.accountId, leadId: a.lead.id } })).toBe(0);
    expect((await service.leadStatus(a.accountId, un1.id)).configured).toBe(true);
    await db.aiClassificationPolicy.delete({ where: { accountId: b.accountId } });
    await expect(service.enqueueUnclassified(b.accountId)).rejects.toThrow('IA não configurada');
  });
});
