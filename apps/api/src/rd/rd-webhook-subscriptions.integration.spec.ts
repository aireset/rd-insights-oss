import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import type { RdConnectionService } from './rd-connection.service';
import { RdWebhookSubscriptionsService } from './rd-webhook-subscriptions.service';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('webhook registration against disposable Postgres and mocked RD', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://none:none@127.0.0.1:1/none' } } });
  const accountId = `webhook-registration-${crypto.randomUUID()}`;
  beforeAll(async () => {
    await db.account.create({ data: { id: accountId, name: 'Registration fixture' } });
    await db.rdConnection.create({ data: { accountId, clientId: 'fixture', clientSecret: 'fixture' } });
  });
  afterAll(async () => {
    await db.rdConnection.deleteMany({ where: { accountId } });
    await db.account.delete({ where: { id: accountId } });
    await db.$disconnect();
  });
  it('commits the secret hash before callback and serializes concurrent registration without duplicates', async () => {
    const subscriptions: Array<{ uuid: string; event_type: string; url: string }> = [];
    const secrets: string[] = [];
    const client = {
      get: async () => ({ webhooks: subscriptions.map((sub) => ({ ...sub })) }),
      post: async (_path: string, body: { event_type: string; url: string }) => {
        const token = new URL(body.url).pathname.split('/').at(-1)!;
        secrets.push(token);
        // Independent query uses a different pool connection from the advisory-lock txn.
        const connection = await db.rdConnection.findUniqueOrThrow({ where: { accountId } });
        expect(connection.webhookTokenHash).toBe(createHash('sha256').update(token).digest('hex'));
        const created = { uuid: crypto.randomUUID(), ...body };
        subscriptions.push(created);
        return created;
      },
      put: async (path: string, body: { event_type: string; url: string }) => {
        Object.assign(subscriptions.find((sub) => path.endsWith(sub.uuid))!, body);
        return {};
      },
    };
    const service = new RdWebhookSubscriptionsService(db as unknown as PrismaService, { client: async () => client } as unknown as RdConnectionService, { get: () => 'https://fixture.example.test' } as unknown as ConfigService<Env, true>);
    await Promise.all([service.register(accountId), service.register(accountId)]);
    expect(subscriptions).toHaveLength(2);
    expect(new Set(secrets).size).toBe(1);
    const stored = await db.rdConnection.findUniqueOrThrow({ where: { accountId } });
    expect(stored.webhookUuids).toHaveLength(2);
    expect(stored.webhookRegisteredAt).toBeInstanceOf(Date);
    expect(JSON.stringify(stored)).not.toContain(secrets[0]);
  });
});
