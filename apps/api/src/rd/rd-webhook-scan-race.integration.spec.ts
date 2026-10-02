import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { RdSyncService } from './rd-sync.service';
import { RdWebhookProcessorService } from './rd-webhook-processor.service';

const database = process.env.DATABASE_TEST_URL;
describe.skipIf(!database)('webhook and history refresh serialization', () => {
  const db = new PrismaClient({ datasources: { db: { url: database ?? 'postgresql://none:none@127.0.0.1:1/none' } } });
  const accountId = `webhook-race-${crypto.randomUUID()}`;
  const uuid = 'race-contact';
  let leadId: string;

  beforeAll(async () => {
    await db.account.create({ data: { id: accountId, name: 'Webhook race fixture' } });
    const lead = await db.lead.create({ data: { accountId, rdUuid: uuid, conversionsCount: 1 } });
    leadId = lead.id;
    await db.leadEvent.create({ data: { accountId, leadId, type: 'CONVERSION', identifier: 'old', occurredAt: new Date('2026-09-27T10:00:00Z') } });
    await db.webhookLog.create({ data: {
      accountId, eventKey: 'race-event', eventType: 'WEBHOOK.CONVERTED', rdUuid: uuid,
      payload: { event_type: 'WEBHOOK.CONVERTED', entity_type: 'CONTACT', event_identifier: 'new', event_timestamp: '2026-09-28T10:00:00Z', contact: { uuid } },
    } });
  });

  afterAll(async () => {
    await db.webhookLog.deleteMany({ where: { accountId } });
    await db.lead.deleteMany({ where: { accountId } });
    await db.account.deleteMany({ where: { id: accountId } });
    await db.$disconnect();
  });

  it('keeps webhook conversions when a history refresh read the ledger first', async () => {
    let ledgerRead!: () => void;
    let releaseRefresh!: () => void;
    const read = new Promise<void>((resolve) => { ledgerRead = resolve; });
    const release = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const log = await db.webhookLog.findUniqueOrThrow({ where: { accountId_eventKey: { accountId, eventKey: 'race-event' } }, select: { id: true } });
    let lockRequested!: () => void;
    const requested = new Promise<void>((resolve) => { lockRequested = resolve; });
    const syncDb = withTransactionProxy(db, (model, method, invoke) => {
      if (model === 'leadEvent' && method === 'findMany') return async (...args: unknown[]) => {
        const rows = await invoke(...args);
        ledgerRead();
        await release;
        return rows;
      };
    });
    const webhookDb = withTransactionProxy(db, undefined, () => lockRequested());
    const sync = new RdSyncService(syncDb as unknown as PrismaService, {} as never);
    const webhook = new RdWebhookProcessorService(webhookDb as unknown as PrismaService);
    const refresh = sync.completeRefreshHistory(accountId, uuid, true);
    await read;
    const actualProcess = webhook.process(accountId, log.id);
    await requested;
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseRefresh();
    await Promise.all([refresh, actualProcess]);
    const saved = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(saved.conversionsCount).toBe(2);
    expect(await db.leadEvent.count({ where: { accountId, leadId, type: 'CONVERSION' } })).toBe(2);
  });

  it('counts a partial refresh event before an identical webhook arrives', async () => {
    const partialUuid = 'partial-contact';
    const lead = await db.lead.create({ data: { accountId, rdUuid: partialUuid } });
    const event = { event_type: 'CONVERSION' as const, event_identifier: 'partial-form', event_timestamp: '2026-09-28T12:00:00Z', payload: {} };
    const payload = { event_type: 'WEBHOOK.CONVERTED', entity_type: 'CONTACT', event_identifier: event.event_identifier, event_timestamp: event.event_timestamp, contact: { uuid: partialUuid } };
    const log = await db.webhookLog.create({ data: { accountId, eventKey: 'partial-event', eventType: payload.event_type, rdUuid: partialUuid, payload } });
    const sync = new RdSyncService(db as unknown as PrismaService, {} as never);
    await sync.refreshEventPage(accountId, { get: async () => ({ events: [event] }) } as never, partialUuid, 'CONVERSION', 1);
    await new RdWebhookProcessorService(db as unknown as PrismaService).process(accountId, log.id);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).conversionsCount).toBe(1);
  });

  it('keeps newer webhook details when an older details response returns late', async () => {
    const contactUuid = 'late-details-contact';
    await db.lead.create({ data: { accountId, rdUuid: contactUuid } });
    let release!: () => void;
    let requested!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { requested = resolve; });
    const sync = new RdSyncService(db as unknown as PrismaService, {} as never);
    const refresh = sync.refreshDetails(accountId, { get: async () => { requested(); await blocked; return { uuid: contactUuid, name: 'Old snapshot' }; } } as never, contactUuid);
    await started;
    await sendWebhook(db, accountId, contactUuid, { name: 'Webhook profile' }, 'late-details');
    release();
    await refresh;
    expect((await db.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: contactUuid } } })).name).toBe('Webhook profile');
  });

  it('keeps newer webhook funnel fields when an older funnel response returns late', async () => {
    const contactUuid = 'late-funnel-contact';
    await db.lead.create({ data: { accountId, rdUuid: contactUuid } });
    let release!: () => void;
    let requested!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { requested = resolve; });
    const sync = new RdSyncService(db as unknown as PrismaService, {} as never);
    const refresh = sync.refreshFunnel(accountId, { get: async () => { requested(); await blocked; return { lifecycle_stage: 'Old stage', opportunity: false }; } } as never, contactUuid);
    await started;
    await sendWebhook(db, accountId, contactUuid, { funnel: { lifecycle_stage: 'New stage', opportunity: true } }, 'late-funnel');
    release();
    await refresh;
    expect((await db.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: contactUuid } } })).lifecycleStage).toBe('New stage');
  });

  it('rejects an older profile response after a second webhook with the same event timestamp', async () => {
    const contactUuid = 'same-timestamp-contact';
    const eventAt = new Date('2026-09-28T13:00:00.000Z');
    await db.lead.create({ data: { accountId, rdUuid: contactUuid, name: 'First event', webhookProfileAt: eventAt } });
    let release!: () => void;
    let requested!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { requested = resolve; });
    const sync = new RdSyncService(db as unknown as PrismaService, {} as never);
    const refresh = sync.refreshDetails(accountId, { get: async () => { requested(); await blocked; return { uuid: contactUuid, name: 'Old response' }; } } as never, contactUuid);
    await started;
    await sendWebhook(db, accountId, contactUuid, { name: 'Second event' }, 'same-timestamp', eventAt.toISOString());
    release();
    await refresh;
    expect((await db.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: contactUuid } } })).name).toBe('Second event');
  });

  it('does not let a list snapshot replace a webhook profile already in the ledger', async () => {
    const contactUuid = 'base-import-contact';
    await db.lead.create({ data: { accountId, rdUuid: contactUuid } });
    await sendWebhook(db, accountId, contactUuid, { name: 'Webhook profile' }, 'base-import');
    const sync = new RdSyncService(db as unknown as PrismaService, {} as never);
    await (sync as unknown as { importarContatoBase(accountId: string, contact: { uuid: string; name: string }): Promise<void> }).importarContatoBase(accountId, { uuid: contactUuid, name: 'Old list snapshot' });
    expect((await db.lead.findUniqueOrThrow({ where: { accountId_rdUuid: { accountId, rdUuid: contactUuid } } })).name).toBe('Webhook profile');
  });
});

async function sendWebhook(db: PrismaClient, accountId: string, uuid: string, contact: Record<string, unknown>, key: string, event_timestamp = new Date(Date.now() + 1_000).toISOString()): Promise<void> {
  const payload = { event_type: 'WEBHOOK.CONVERTED', entity_type: 'CONTACT', event_identifier: key, event_timestamp, contact: { uuid, ...contact } };
  const log = await db.webhookLog.create({ data: { accountId, eventKey: key, eventType: payload.event_type, rdUuid: uuid, payload } });
  await new RdWebhookProcessorService(db as unknown as PrismaService).process(accountId, log.id);
}

function withTransactionProxy(client: PrismaClient, wrap?: (model: string, method: string, invoke: (...args: unknown[]) => Promise<unknown>) => ((...args: unknown[]) => Promise<unknown>) | undefined, onLock?: () => void): PrismaClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === '$transaction') return (callback: (tx: unknown) => Promise<unknown>, options?: object) => target.$transaction((tx) => callback(wrapTransaction(tx, wrap, onLock)), options);
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value === 'function') return value.bind(target);
      if (!value || typeof value !== 'object') return value;
      return wrapModel(value, String(property), wrap);
    },
  });
}

function wrapTransaction(tx: object, wrap?: (model: string, method: string, invoke: (...args: unknown[]) => Promise<unknown>) => ((...args: unknown[]) => Promise<unknown>) | undefined, onLock?: () => void): object {
  return new Proxy(tx, {
    get(target, property, receiver) {
      const model = Reflect.get(target, property, receiver) as object;
      if (String(property).startsWith('$executeRaw') && typeof model === 'function') return (...args: unknown[]) => { onLock?.(); return (model as (...args: unknown[]) => Promise<unknown>).apply(target, args); };
      if (!model || typeof model !== 'object') return model;
      return wrapModel(model, String(property), wrap);
    },
  });
}

function wrapModel(model: object, name: string, wrap?: (model: string, method: string, invoke: (...args: unknown[]) => Promise<unknown>) => ((...args: unknown[]) => Promise<unknown>) | undefined): object {
  return new Proxy(model, {
    get(modelTarget, method, modelReceiver) {
      const value = Reflect.get(modelTarget, method, modelReceiver) as unknown;
      if (typeof value !== 'function') return value;
      const invoke = (...args: unknown[]) => (value as (...args: unknown[]) => Promise<unknown>).apply(modelTarget, args);
      return wrap?.(name, String(method), invoke) ?? invoke;
    },
  });
}
