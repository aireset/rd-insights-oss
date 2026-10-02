import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { RdCatalogService } from './rd-catalog.service';

const url = process.env.DATABASE_TEST_URL;
describe.skipIf(!url)('catalog completion against disposable Postgres', () => {
  it('does not advance catalog freshness if persisting run completion fails', async () => {
    const db = new PrismaClient({ datasources: { db: { url } } });
    const accountId = `catalog-${crypto.randomUUID()}`;
    try {
      await db.account.create({ data: { id: accountId, name: 'Catalog fixture' } });
      await db.rdConnection.create({ data: { accountId, clientId: 'fixture', clientSecret: 'fixture', status: 'active' } });
      const run = await db.syncRun.create({ data: { accountId, kind: 'catalog' } });
      const failing = db.$extends({ query: { syncRun: { async update({ args, query }) {
        if (args.data.status === 'completed') throw new Error('Simulated write failure');
        return query(args);
      } } } });
      const service = new RdCatalogService(failing as never, { segmentations: async () => [], marcarErro: async () => {} } as never, { consumeCatalog: async () => {} } as never);
      await service.run(accountId, run.id);
      expect((await db.rdConnection.findUniqueOrThrow({ where: { accountId } })).catalogSyncedAt).toBeNull();
      expect(await db.syncRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'partial', finishedAt: null });
    } finally {
      await db.syncRun.deleteMany({ where: { accountId } });
      await db.rdConnection.deleteMany({ where: { accountId } });
      await db.account.deleteMany({ where: { id: accountId } });
      await db.$disconnect();
    }
  });
});
