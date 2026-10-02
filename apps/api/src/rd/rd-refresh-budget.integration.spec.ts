import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { RdRefreshBudgetService, RefreshBudgetExhaustedError } from './rd-refresh-budget.service';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('refresh request budget against disposable Postgres', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled' } } });
  const accountId = `budget-${crypto.randomUUID()}`;
  const otherId = `${accountId}-other`;
  const service = new RdRefreshBudgetService(db as unknown as PrismaService);
  beforeAll(async () => {
    for (const id of [accountId, otherId]) {
      await db.account.create({ data: { id, name: 'Budget fixture' } });
      await db.rdConnection.create({ data: { accountId: id, clientId: 'fixture', clientSecret: 'fixture', refreshDailyBudget: 2 } });
    }
  });
  afterAll(async () => {
    await db.rdConnection.deleteMany({ where: { accountId: { in: [accountId, otherId] } } });
    await db.account.deleteMany({ where: { id: { in: [accountId, otherId] } } });
    await db.$disconnect();
  });
  it('does not overspend during concurrent reservations and keeps accounts independent', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => service.consume(accountId)));
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(attempts.filter((r) => r.status === 'rejected').every((r) => r.status === 'rejected' && r.reason instanceof RefreshBudgetExhaustedError)).toBe(true);
    await expect(service.consume(otherId)).resolves.toBeUndefined();
    expect((await db.rdConnection.findUniqueOrThrow({ where: { accountId } })).refreshRequestsUsed).toBe(2);
  });
  it('renews on the next UTC day and preserves consumption across service restart', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    await db.rdConnection.update({ where: { accountId }, data: { refreshBudgetDay: yesterday, refreshRequestsUsed: 2 } });
    const restarted = new RdRefreshBudgetService(db as unknown as PrismaService);
    await restarted.consume(accountId);
    expect((await db.rdConnection.findUniqueOrThrow({ where: { accountId } })).refreshRequestsUsed).toBe(1);
  });
  it('bounds catalog calls separately so a low refresh budget still advances leads', async () => {
    await db.rdConnection.update({ where: { accountId }, data: { catalogRequestsUsed: 99, catalogBudgetDay: new Date(new Date().toISOString().slice(0, 10)) } });
    await service.consumeCatalog(accountId);
    await expect(service.consumeCatalog(accountId)).rejects.toBeInstanceOf(RefreshBudgetExhaustedError);
    await expect(service.consume(accountId)).resolves.toBeUndefined();
  });
});
