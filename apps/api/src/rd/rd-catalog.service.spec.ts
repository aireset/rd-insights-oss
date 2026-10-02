import { describe, expect, it, vi } from 'vitest';
import { RdProviderError } from '../common/errors';
import { RefreshBudgetExhaustedError } from './rd-refresh-budget.service';
import { RdCatalogService } from './rd-catalog.service';

function setup(run: Record<string, unknown> | null = { id: 'run-1', kind: 'catalog', segmentId: null, finishedAt: null }, status = 'active') {
  const events: string[] = [];
  const connectionUpdate = vi.fn(async () => ({}));
  const runUpdate = vi.fn(async () => ({}));
  const findRun = vi.fn(async () => run);
  const findConnection = vi.fn(async () => ({ status }));
  const delegates = { syncRun: { findFirst: findRun, update: runUpdate }, rdConnection: { findUnique: findConnection, update: connectionUpdate } };
  const prisma = { ...delegates, $transaction: async (fn: (tx: typeof delegates) => Promise<unknown>) => fn(delegates) } as never;
  const segmentations = vi.fn(async (_accountId: string, beforeRequest?: () => Promise<void>) => { events.push('segmentations'); await beforeRequest?.(); events.push('http'); return []; });
  const marcarErro = vi.fn(async () => undefined);
  const consumeCatalog = vi.fn(async () => { events.push('budget'); });
  const service = new RdCatalogService(prisma, { segmentations, marcarErro } as never, { consumeCatalog } as never);
  return { service, findRun, findConnection, runUpdate, connectionUpdate, segmentations, marcarErro, consumeCatalog, events };
}

describe('RdCatalogService', () => {
  it('debita antes da chamada e marca sucesso apenas ao terminar', async () => {
    const s = setup();
    await s.service.run('account-1', 'run-1');
    expect(s.findRun).toHaveBeenCalledWith({ where: { id: 'run-1', accountId: 'account-1' } });
    expect(s.connectionUpdate).toHaveBeenNthCalledWith(1, { where: { accountId: 'account-1' }, data: { catalogAttemptAt: expect.any(Date), catalogError: null } });
    expect(s.events).toEqual(['segmentations', 'budget', 'http']);
    expect(s.segmentations).toHaveBeenCalledWith('account-1', expect.any(Function));
    expect(s.runUpdate).toHaveBeenCalledWith({ where: { id: 'run-1', accountId: 'account-1' }, data: { status: 'completed', finishedAt: expect.any(Date), error: null } });
    expect(s.connectionUpdate).toHaveBeenLastCalledWith({ where: { accountId: 'account-1' }, data: { catalogSyncedAt: expect.any(Date), catalogError: null } });
  });

  it('mantém watermark em falha e orçamento esgotado não marca erro de conexão', async () => {
    const s = setup();
    s.consumeCatalog.mockRejectedValueOnce(new RefreshBudgetExhaustedError());
    await s.service.run('account-1', 'run-1');
    expect(s.segmentations).toHaveBeenCalledOnce();
    expect(s.events).toEqual(['segmentations']);
    expect(s.connectionUpdate).toHaveBeenCalledTimes(2);
    expect(s.connectionUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ catalogAttemptAt: expect.any(Date) }) }));
    expect(s.runUpdate).toHaveBeenCalledWith({ where: { id: 'run-1', accountId: 'account-1' }, data: { status: 'partial', error: 'Orçamento diário do catálogo esgotado; tente no próximo ciclo.' } });
  });

  it('pausa e exige reautorização em 401 sem expor mensagem do provedor', async () => {
    const s = setup();
    s.segmentations.mockRejectedValueOnce(new RdProviderError('token secreto expirou', 401));
    await s.service.run('account-1', 'run-1');
    expect(s.marcarErro).toHaveBeenCalledWith('account-1', expect.any(RdProviderError));
    expect(s.runUpdate).toHaveBeenCalledWith({ where: { id: 'run-1', accountId: 'account-1' }, data: { status: 'paused', error: 'Autorize novamente a conexão RD para atualizar o catálogo.' } });
    expect(s.connectionUpdate).toHaveBeenLastCalledWith({ where: { accountId: 'account-1' }, data: { catalogError: 'Autorize novamente a conexão RD para atualizar o catálogo.' } });
  });

  it('ignora run de outra conta/tipo e conexão sem autorização', async () => {
    const wrong = setup({ id: 'run-1', kind: 'refresh', segmentId: null, finishedAt: null });
    await wrong.service.run('account-1', 'run-1');
    expect(wrong.connectionUpdate).not.toHaveBeenCalled();
    const inactive = setup(undefined, 'reauth_required');
    await inactive.service.run('account-1', 'run-1');
    expect(inactive.segmentations).not.toHaveBeenCalled();
    expect(inactive.runUpdate).toHaveBeenCalledWith({ where: { id: 'run-1', accountId: 'account-1' }, data: { status: 'paused', error: 'A conexão RD precisa estar ativa para atualizar o catálogo.' } });
  });
});
