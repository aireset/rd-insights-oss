import { describe, expect, it, vi } from 'vitest';
import { RdProviderError } from '../common/errors';
import type { Env } from '../config/env.schema';
import { RdConnectionService } from './rd-connection.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';
import { RefreshBudgetExhaustedError } from './rd-refresh-budget.service';

vi.mock('../prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

describe('RdConnectionService.credenciais (via authorizeUrl)', () => {
  it('conta sem credencial no painel + env presente → origem env, authorizeUrl usa client_id do env', async () => {
    const prisma = {
      rdConnection: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    } as unknown as PrismaService;
    const config = makeConfig({ RD_API_BASE_URL: 'https://api.rd.services', APP_URL: 'http://app', JWT_ACCESS_SECRET: 'x'.repeat(16), RD_CLIENT_ID: 'env-client-id', RD_CLIENT_SECRET: 'env-client-secret' });
    const svc = new RdConnectionService(prisma, config);
    const url = await svc.authorizeUrl('acc-1');
    expect(url).toContain('client_id=env-client-id');
    expect((prisma.rdConnection.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toMatchObject({ accountId: 'acc-1', clientId: 'env-client-id', status: 'pending' });
  });

  it('conta com credencial no painel → origem painel mesmo com env presente', async () => {
    const prisma = {
      rdConnection: { findUnique: vi.fn(async () => ({ clientId: 'painel-id', clientSecret: 'painel-secret' })), create: vi.fn() },
    } as unknown as PrismaService;
    const config = makeConfig({ RD_API_BASE_URL: 'https://api.rd.services', APP_URL: 'http://app', JWT_ACCESS_SECRET: 'x'.repeat(16), RD_CLIENT_ID: 'env-client-id', RD_CLIENT_SECRET: 'env-client-secret' });
    const svc = new RdConnectionService(prisma, config);
    const url = await svc.authorizeUrl('acc-2');
    expect(url).toContain('client_id=painel-id');
    expect(prisma.rdConnection.create).not.toHaveBeenCalled();
  });
});

describe('RdConnectionService segmentações', () => {
  it('preserves the catalog when a successful response contains a malformed segment', async () => {
    const transaction = vi.fn();
    const svc = new RdConnectionService({ $transaction: transaction, rdConnection: { update: vi.fn() } } as unknown as PrismaService, makeConfig({}));
    vi.spyOn(svc, 'client').mockResolvedValue({ get: vi.fn().mockResolvedValue({ segmentations: [{ id: 1, name: null }] }) } as never);
    await expect(svc.segmentations('acc-1')).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it('does not mark the connection broken when a scheduled catalog exhausts its budget', async () => {
    const update = vi.fn();
    const svc = new RdConnectionService({ rdConnection: { update } } as unknown as PrismaService, makeConfig({}));
    vi.spyOn(svc, 'client').mockResolvedValue({ get: vi.fn().mockRejectedValue(new RefreshBudgetExhaustedError()) } as never);
    await expect(svc.segmentations('acc-1')).rejects.toBeInstanceOf(RefreshBudgetExhaustedError);
    expect(update).not.toHaveBeenCalled();
  });
  it('percorre catálogo paginado antes de atualizar disponibilidade', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ segmentations: Array.from({ length: 125 }, (_, i) => ({ id: i + 1, name: 'S' + (i + 1), standard: false })) })
      .mockResolvedValueOnce({ segmentations: [{ id: 126, name: 'S126', standard: true }] });
    const segmentation = { upsert: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) };
    const prisma = {
      rdSegmentation: { ...segmentation, findMany: vi.fn(async () => Array.from({ length: 126 }, (_, i) => ({ rdId: String(i + 1), name: 'S' + (i + 1), standard: false, selected: false, available: true, coverage: 'unknown' }))) },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ rdSegmentation: segmentation })),
      rdConnection: { update: vi.fn() },
    } as unknown as PrismaService;
    const svc = new RdConnectionService(prisma, makeConfig({}));
    vi.spyOn(svc, 'client').mockResolvedValue({ get } as never);
    const result = await svc.segmentations('acc-1');
    expect(result).toHaveLength(126);
    expect(get).toHaveBeenNthCalledWith(1, '/platform/segmentations', { page: 1, page_size: 125 });
    expect(get).toHaveBeenNthCalledWith(2, '/platform/segmentations', { page: 2, page_size: 125 });
    expect(segmentation.updateMany).toHaveBeenCalledWith({ where: { accountId: 'acc-1', rdId: { notIn: Array.from({ length: 126 }, (_, i) => String(i + 1)) } }, data: { available: false } });
  });

  it('rejeita segmentação que não pertence ao catálogo da conta', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ rdSegmentation: { findMany } })) } as unknown as PrismaService;
    const svc = new RdConnectionService(prisma, makeConfig({}));
    await expect(svc.setSegmentations('acc-1', ['other-account-segment'])).rejects.toMatchObject({ status: 404 });
    expect(findMany).toHaveBeenCalledWith({ where: { accountId: 'acc-1', rdId: { in: ['other-account-segment'] } } });
  });

  it('remove seleção RD indisponível sem bloquear outra seleção', async () => {
    const records = [
      { rdId: 'gone', name: 'Removida', standard: false, selected: true, available: false, coverage: 'unknown' },
      { rdId: 'live', name: 'Ativa', standard: false, selected: false, available: true, coverage: 'unknown' },
    ];
    const findMany = vi.fn(async (args: { where: { available?: boolean } }) => args.where.available === true ? records.filter((s) => s.available) : records);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const connectionUpdate = vi.fn(async () => ({}));
    const prisma = {
      rdConnection: { update: connectionUpdate },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ rdSegmentation: { findMany, updateMany }, rdConnection: { update: connectionUpdate } })),
    } as unknown as PrismaService;
    const svc = new RdConnectionService(prisma, makeConfig({}));
    vi.spyOn(svc, 'view').mockResolvedValue({} as never);

    await expect(svc.setSegmentations('acc-1', ['gone', 'live'])).resolves.toBeDefined();

    expect(findMany).toHaveBeenCalledWith({ where: { accountId: 'acc-1', rdId: { in: ['gone', 'live'] } } });
    expect(updateMany).toHaveBeenNthCalledWith(2, { where: { accountId: 'acc-1', rdId: { in: ['live'] }, available: true }, data: { selected: true } });
    expect(connectionUpdate).toHaveBeenCalledWith({ where: { accountId: 'acc-1' }, data: { segmentationId: 'live', segmentationName: 'Ativa', status: 'active' } });
  });

  it('persiste várias seleções e mantém a primeira como alias legado', async () => {
    const findMany = vi.fn(async () => [
      { rdId: 'seg-b', name: 'Beta', standard: false, selected: false, available: true, coverage: 'unknown' },
      { rdId: 'seg-a', name: 'Alpha', standard: false, selected: false, available: true, coverage: 'unknown' },
    ]);
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const connectionUpdate = vi.fn(async () => ({}));
    const prisma = {
      rdConnection: { update: connectionUpdate },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ rdSegmentation: { findMany, updateMany }, rdConnection: { update: connectionUpdate } })),
    } as unknown as PrismaService;
    const svc = new RdConnectionService(prisma, makeConfig({}));
    vi.spyOn(svc, 'view').mockResolvedValue({} as never);
    await svc.setSegmentations('acc-1', ['seg-b', 'seg-a']);
    expect(findMany).toHaveBeenCalledWith({ where: { accountId: 'acc-1', rdId: { in: ['seg-b', 'seg-a'] } } });
    expect(updateMany).toHaveBeenNthCalledWith(1, { where: { accountId: 'acc-1', selected: true }, data: { selected: false } });
    expect(updateMany).toHaveBeenNthCalledWith(2, { where: { accountId: 'acc-1', rdId: { in: ['seg-b', 'seg-a'] }, available: true }, data: { selected: true } });
    expect(connectionUpdate).toHaveBeenCalledWith({ where: { accountId: 'acc-1' }, data: { segmentationId: 'seg-a', segmentationName: 'Alpha', status: 'active' } });
  });
});

describe('RdConnectionService.marcarErro', () => {
  it('marks a 401 connection for reauthorization', async () => {
    const update = vi.fn(async () => ({}));
    const prisma = { rdConnection: { update } } as unknown as PrismaService;
    const config = { get: vi.fn() } as unknown as ConfigService<Env, true>;
    const service = new RdConnectionService(prisma, config, { acquire: vi.fn() } as never);

    await service.marcarErro('account-1', new RdProviderError('Token expirado', 401));

    expect(update).toHaveBeenCalledWith({
      where: { accountId: 'account-1' },
      data: { status: 'reauth_required', lastError: 'Token expirado' },
    });
  });
});
