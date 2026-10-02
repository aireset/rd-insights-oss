import { createHash } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
type SubscriptionBody = { event_type: string; entity_type: string; http_method: string; include_relations: string[]; url: string };
import { describe, expect, it, vi } from 'vitest';
import { BusinessError, NotFoundError, RdProviderError } from '../common/errors';
import type { PrismaService } from '../prisma/prisma.service';
import type { RdConnectionService } from './rd-connection.service';
import { RdWebhookSubscriptionsService } from './rd-webhook-subscriptions.service';

describe('RdWebhookSubscriptionsService', () => {
  it('persists only the token hash before creating both subscriptions', async () => {
    const row: { webhookTokenHash?: string; webhookUuids: string[] } = { webhookUuids: [] };
    const uuids = ['uuid-converted', 'uuid-opportunity'];
    const prisma = {
      $executeRaw: vi.fn(),
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ $executeRaw: vi.fn() })),
      rdConnection: {
        findUnique: vi.fn(async () => ({ ...row, webhookTokenHash: row.webhookTokenHash ?? null })),
        update: vi.fn(async ({ data }: { data: Partial<typeof row> }) => Object.assign(row, data)),
      },
    } as unknown as PrismaService;
    const calls: Array<{ method: string; path: string; body?: SubscriptionBody }> = [];
    const client = {
      get: vi.fn(async (path: string) => { calls.push({ method: 'GET', path }); return { webhooks: [] }; }),
      post: vi.fn(async (path: string, body: SubscriptionBody) => {
        expect(row.webhookTokenHash).toBe(createHash('sha256').update(new URL(body.url).pathname.split('/').at(-1)!).digest('hex'));
        calls.push({ method: 'POST', path, body });
        return { uuid: uuids[calls.filter((c) => c.method === 'POST').length - 1] };
      }),
      put: vi.fn(),
    };
    const conn = { client: vi.fn(async () => client) } as unknown as RdConnectionService;
    const config = { get: () => 'https://app.example.test' } as unknown as ConfigService<Env, true>;
    const service = new RdWebhookSubscriptionsService(prisma, conn, config);

    await service.register('account-1');

    expect(client.get).toHaveBeenCalledWith('/integrations/webhooks');
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body!.event_type)).toEqual(['WEBHOOK.CONVERTED', 'WEBHOOK.MARKED_OPPORTUNITY']);
    expect(calls.filter((c) => c.method === 'POST').every((c) => c.body!.entity_type === 'CONTACT' && c.body!.http_method === 'POST' && c.body!.include_relations.includes('COMPANY') && c.body!.include_relations.includes('CONTACT_FUNNEL'))).toBe(true);
    expect(row.webhookUuids).toEqual(uuids);
    expect(row.webhookTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain('/api/rd/webhooks/');
  });

  it('reuses a recoverable callback token and updates known subscriptions without duplicates', async () => {
    const token = 'a'.repeat(64);
    const callback = `https://app.example.test/api/rd/webhooks/account-1/${token}`;
    const uuids = ['uuid-converted', 'uuid-opportunity'];
    const row = { webhookTokenHash: createHash('sha256').update(token).digest('hex'), webhookUuids: uuids };
    const subscriptions = uuids.map((uuid, i) => ({ uuid, url: callback, event_type: ['WEBHOOK.CONVERTED', 'WEBHOOK.MARKED_OPPORTUNITY'][i] }));
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ $executeRaw: vi.fn() })),
      rdConnection: { findUnique: vi.fn(async () => row), update: vi.fn(async () => {}) },
    } as unknown as PrismaService;
    const client = { get: vi.fn(async () => ({ webhooks: subscriptions })), post: vi.fn(), put: vi.fn(async () => ({})) };
    const service = new RdWebhookSubscriptionsService(prisma, { client: async () => client } as unknown as RdConnectionService, { get: () => 'https://app.example.test' } as unknown as ConfigService<Env, true>);

    await service.register('account-1');

    expect(client.post).not.toHaveBeenCalled();
    expect(client.put).toHaveBeenCalledTimes(2);
    expect(client.put.mock.calls.map(([path]) => path)).toEqual(['/integrations/webhooks/uuid-converted', '/integrations/webhooks/uuid-opportunity']);
    expect(prisma.rdConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ webhookRegisteredAt: expect.any(Date) }) }));
  });

  it('replaces deleted webhook ids and never keeps obsolete ids during partial progress', async () => {
    const token = 'b'.repeat(64);
    const callback = `https://app.example.test/api/rd/webhooks/account-1/${token}`;
    const row = { webhookTokenHash: createHash('sha256').update(token).digest('hex'), webhookUuids: ['deleted-old', 'uuid-converted'] };
    const writes: string[][] = [];
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ $executeRaw: vi.fn() })),
      rdConnection: {
        findUnique: vi.fn(async () => row),
        update: vi.fn(async ({ data }: { data: Partial<typeof row> }) => {
          if (data.webhookUuids) writes.push([...data.webhookUuids]);
          Object.assign(row, data);
        }),
      },
    } as unknown as PrismaService;
    const client = {
      get: vi.fn(async () => ({ webhooks: [{ uuid: 'uuid-converted', url: callback, event_type: 'WEBHOOK.CONVERTED' }] })),
      post: vi.fn(async () => ({ uuid: 'uuid-opportunity-new' })),
      put: vi.fn(async () => ({})),
    };
    const service = new RdWebhookSubscriptionsService(prisma, { client: async () => client } as unknown as RdConnectionService, { get: () => 'https://app.example.test' } as unknown as ConfigService<Env, true>);

    await service.register('account-1');

    expect(writes).toEqual([['uuid-converted'], ['uuid-converted', 'uuid-opportunity-new']]);
    expect(row.webhookUuids).toEqual(['uuid-converted', 'uuid-opportunity-new']);
  });

  it('reconhece assinaturas que o RD lista com event_type em minúsculas', async () => {
    const token = 'd'.repeat(64);
    const callback = `https://app.example.test/api/rd/webhooks/account-1/${token}`;
    const uuids = ['uuid-converted', 'uuid-opportunity'];
    const row = { webhookTokenHash: createHash('sha256').update(token).digest('hex'), webhookUuids: uuids };
    const prisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ $executeRaw: vi.fn() })),
      rdConnection: { findUnique: vi.fn(async () => row), update: vi.fn(async () => {}) },
    } as unknown as PrismaService;
    const client = {
      get: vi.fn(async () => ({ webhooks: [{ uuid: uuids[0], url: callback, event_type: 'webhook.converted' }, { uuid: uuids[1], url: callback, event_type: 'webhook.marked_opportunity' }] })),
      post: vi.fn(), put: vi.fn(async () => ({})),
    };
    const service = new RdWebhookSubscriptionsService(prisma, { client: async () => client } as unknown as RdConnectionService, { get: () => 'https://app.example.test' } as unknown as ConfigService<Env, true>);
    await service.register('account-1');
    expect(client.post).not.toHaveBeenCalled();
    expect(client.put).toHaveBeenCalledTimes(2);
  });

  it('reports a missing connection as not found', async () => {
    const prisma = { $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ $executeRaw: vi.fn() })), rdConnection: { findUnique: vi.fn(async () => null), update: vi.fn() } } as unknown as PrismaService;
    const service = new RdWebhookSubscriptionsService(prisma, {} as RdConnectionService, { get: () => 'https://app.example.test' } as unknown as ConfigService<Env, true>);
    await expect(service.register('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('keeps ownership of an existing subscription when rotation fails halfway', async () => {
    const token = 'c'.repeat(64);
    const row = { webhookTokenHash: createHash('sha256').update(token).digest('hex'), webhookUuids: ['converted', 'opportunity'] };
    const oldCallback = `https://old.example.test/api/rd/webhooks/account-1/${token}`;
    const subscriptions = [{ uuid: 'converted', event_type: 'WEBHOOK.CONVERTED', url: oldCallback }, { uuid: 'opportunity', event_type: 'WEBHOOK.MARKED_OPPORTUNITY', url: oldCallback }];
    let failSecond = true;
    const prisma = {
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({ $executeRaw: vi.fn() }),
      rdConnection: { findUnique: async () => ({ ...row, webhookUuids: [...row.webhookUuids] }), update: async ({ data }: { data: Partial<typeof row> }) => Object.assign(row, data) },
    } as unknown as PrismaService;
    const client = {
      get: async () => ({ webhooks: subscriptions.map((sub) => ({ ...sub })) }),
      post: vi.fn(async (_path: string, body: SubscriptionBody) => { const sub = { uuid: 'duplicate', ...body }; subscriptions.push(sub); return sub; }),
      put: async (path: string, body: SubscriptionBody) => {
        if (path.endsWith('/opportunity') && failSecond) { failSecond = false; throw new Error('temporary outage'); }
        Object.assign(subscriptions.find((sub) => path.endsWith(`/${sub.uuid}`))!, body);
        return {};
      },
    };
    const service = new RdWebhookSubscriptionsService(prisma, { client: async () => client } as unknown as RdConnectionService, { get: () => 'https://new.example.test' } as unknown as ConfigService<Env, true>);
    await expect(service.register('account-1')).rejects.toBeInstanceOf(BusinessError);
    await service.register('account-1');
    expect(client.post).not.toHaveBeenCalled();
    expect(subscriptions).toHaveLength(2);
    expect(row.webhookUuids).toEqual(['converted', 'opportunity']);
  });

  it('stores sanitized configuration errors and keeps their readable business message', async () => {
    const prisma = { $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ $executeRaw: vi.fn() })), rdConnection: { findUnique: vi.fn(async () => ({ webhookUuids: [] })), update: vi.fn(async () => {}) } } as unknown as PrismaService;
    const service = new RdWebhookSubscriptionsService(prisma, {} as RdConnectionService, { get: () => 'http://app.example.test' } as unknown as ConfigService<Env, true>);
    await expect(service.register('account-1')).rejects.toBeInstanceOf(BusinessError);
    expect(prisma.rdConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: { webhookError: 'Falha ao registrar webhooks do RD' } }));
  });

  it('preserves a readable authorization error from client creation and records webhook error', async () => {
    const prisma = { $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ $executeRaw: vi.fn() })), rdConnection: { findUnique: vi.fn(async () => ({ webhookUuids: [] })), update: vi.fn(async () => {}) } } as unknown as PrismaService;
    const service = new RdWebhookSubscriptionsService(prisma, { client: vi.fn(async () => { throw new BusinessError('Conta ainda não autorizada no RD'); }) } as unknown as RdConnectionService, { get: () => 'https://app.example.test' } as unknown as ConfigService<Env, true>);
    await expect(service.register('account-1')).rejects.toThrow('Conta ainda não autorizada no RD');
    expect(prisma.rdConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: { webhookError: 'Falha ao registrar webhooks do RD' } }));
  });

  it('marks the RD connection for reauthentication after webhook authorization fails', async () => {
    const prisma = { $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ $executeRaw: vi.fn() })), rdConnection: { findUnique: vi.fn(async () => ({ webhookUuids: [] })), update: vi.fn(async () => {}) } } as unknown as PrismaService;
    const failure = new RdProviderError('RD respondeu 401', 401);
    const client = { get: vi.fn(async () => { throw failure; }) };
    const marcarErro = vi.fn(async () => {});
    const service = new RdWebhookSubscriptionsService(prisma, { client: async () => client, marcarErro } as unknown as RdConnectionService, { get: () => 'https://app.example.test' } as unknown as ConfigService<Env, true>);
    await expect(service.register('account-1')).rejects.toBe(failure);
    expect(marcarErro).toHaveBeenCalledWith('account-1', failure);
  });
});
