import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { RdWebhookProcessorService } from './rd-webhook-processor.service';
import { parseWebhookPayload, webhookEventKey } from './rd-webhook-payload';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('RD webhook processor against disposable Postgres', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled' } } });
  const accountId = 'webhook-' + crypto.randomUUID();
  const otherAccountId = accountId + '-other';
  const service = new RdWebhookProcessorService(db as unknown as PrismaService);
  const makePayload = (overrides: Record<string, unknown> = {}) => parseWebhookPayload({
    event_type: 'WEBHOOK.CONVERTED', entity_type: 'CONTACT', event_identifier: 'form-1',
    timestamp: new Date().toISOString(), event_timestamp: '2026-09-28T10:00:00.000Z',
    contact: { uuid: 'contact-1', name: 'Ana', email: 'ana@example.test', company: { name: 'Acme' }, funnel: { lifecycle_stage: 'Lead', opportunity: false }, cf_plan: 'pro' },
    ...overrides,
  });
  const addLog = async (account: string, payload: ReturnType<typeof makePayload>) => db.webhookLog.create({ data: { accountId: account, eventKey: webhookEventKey(payload), eventType: payload.event_type, rdUuid: payload.contact.uuid, payload: payload as never } });
  beforeAll(async () => {
    for (const id of [accountId, otherAccountId]) await db.account.create({ data: { id, name: 'Webhook fixture' } });
  });
  afterAll(async () => {
    await db.webhookLog.deleteMany({ where: { accountId: { in: [accountId, otherAccountId] } } });
    await db.leadEvent.deleteMany({ where: { accountId: { in: [accountId, otherAccountId] } } });
    await db.lead.deleteMany({ where: { accountId: { in: [accountId, otherAccountId] } } });
    await db.account.deleteMany({ where: { id: { in: [accountId, otherAccountId] } } });
    await db.$disconnect();
  });

  it('processes a repeated delivery once and counts only conversions', async () => {
    const payload = makePayload();
    const log = await addLog(accountId, payload);
    await service.process(accountId, log.id);
    await service.process(accountId, log.id);
    expect(await db.lead.count({ where: { accountId, rdUuid: 'contact-1' } })).toBe(1);
    expect(await db.leadEvent.count({ where: { accountId, type: 'CONVERSION' } })).toBe(1);
    expect(await db.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: 'contact-1' } } })).toMatchObject({ conversionsCount: 1, company: 'Acme', customFields: { cf_plan: 'pro' } });
    expect(await db.webhookLog.findUniqueOrThrow({ where: { id: log.id } })).toMatchObject({ status: 'completed', processedAt: expect.any(Date) });
  });

  it('records marked opportunity separately without adding a conversion', async () => {
    const payload = makePayload({ event_type: 'WEBHOOK.MARKED_OPPORTUNITY', event_identifier: 'default', event_timestamp: '2026-09-28T10:01:00.000Z', contact: { uuid: 'opportunity-contact' } });
    const log = await addLog(accountId, payload);
    await service.process(accountId, log.id);
    expect(await db.leadEvent.count({ where: { accountId, type: 'OPPORTUNITY' } })).toBe(1);
    expect(await db.leadEvent.count({ where: { accountId, type: 'CONVERSION', lead: { rdUuid: 'opportunity-contact' } } })).toBe(0);
    expect(await db.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: 'opportunity-contact' } } })).toMatchObject({ conversionsCount: 0, opportunity: true });
  });

  it('serializes concurrent duplicate processing and isolates tenant log lookup', async () => {
    const payload = makePayload({ event_identifier: 'parallel' });
    const log = await addLog(accountId, payload);
    await Promise.all([service.process(accountId, log.id), service.process(accountId, log.id)]);
    expect(await db.leadEvent.count({ where: { accountId, identifier: 'parallel' } })).toBe(1);
    await expect(service.process(otherAccountId, log.id)).rejects.toThrow();
    expect(await db.lead.count({ where: { accountId: otherAccountId, rdUuid: 'contact-1' } })).toBe(0);
  });

  it('keeps a newer enriched profile when an older webhook arrives', async () => {
    const uuid = 'stale-' + crypto.randomUUID();
    await db.lead.create({ data: { accountId, rdUuid: uuid, name: 'Fresh name', enrichedAt: new Date('2026-09-28T11:00:00Z'), webhookProfileAt: new Date('2026-09-28T10:30:00Z') } });
    const payload = makePayload({ event_identifier: 'stale-profile', event_timestamp: '2026-09-28T10:00:00Z', contact: { uuid, name: 'Old name' } });
    const log = await addLog(accountId, payload);
    await service.process(accountId, log.id);
    expect(await db.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: uuid } } })).toMatchObject({ name: 'Fresh name' });
  });

  it('rolls back lead and event writes if completion fails', async () => {
    const payload = makePayload({ event_identifier: 'rollback', contact: { uuid: 'rollback-contact' } });
    const log = await addLog(accountId, payload);
    const failingPrisma = {
      $transaction: (fn: (tx: unknown) => Promise<void>) => db.$transaction((tx) => fn(new Proxy(tx, {
        get(target, key, receiver) {
          if (key === 'webhookLog') return new Proxy(tx.webhookLog, {
            get(delegate, method) {
              if (method === 'update') return async () => { throw new Error('forced completion failure'); };
              const value = Reflect.get(delegate, method);
              return typeof value === 'function' ? value.bind(delegate) : value;
            },
          });
          return Reflect.get(target, key, receiver);
        },
      })) as never),
    };
    const failingService = new RdWebhookProcessorService(failingPrisma as unknown as PrismaService);
    await expect(failingService.process(accountId, log.id)).rejects.toThrow('forced completion failure');
    expect(await db.lead.count({ where: { accountId, rdUuid: 'rollback-contact' } })).toBe(0);
    expect(await db.leadEvent.count({ where: { accountId, identifier: 'rollback' } })).toBe(0);
  });
});
