import { Injectable } from '@nestjs/common';
import { RdProviderError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { RdConnectionService } from './rd-connection.service';
import { RdRefreshBudgetService, RefreshBudgetExhaustedError } from './rd-refresh-budget.service';

const REAUTH_MESSAGE = 'Autorize novamente a conexão RD para atualizar o catálogo.';
const INACTIVE_MESSAGE = 'A conexão RD precisa estar ativa para atualizar o catálogo.';
const BUDGET_MESSAGE = 'Orçamento diário do catálogo esgotado; tente no próximo ciclo.';
const FAILURE_MESSAGE = 'Falha ao atualizar o catálogo RD; tente no próximo ciclo.';

@Injectable()
export class RdCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conn: RdConnectionService,
    private readonly budget: RdRefreshBudgetService,
  ) {}

  async run(accountId: string, runId: string): Promise<void> {
    const where = { id: runId, accountId };
    const run = await this.prisma.syncRun.findFirst({ where });
    if (!run || run.kind !== 'catalog' || run.segmentId !== null || run.finishedAt) return;

    const connection = await this.prisma.rdConnection.findUnique({ where: { accountId }, select: { status: true } });
    if (!connection || !['active', 'error'].includes(connection.status)) {
      await this.prisma.syncRun.update({ where, data: { status: 'paused', error: INACTIVE_MESSAGE } });
      return;
    }

    await this.prisma.rdConnection.update({ where: { accountId }, data: { catalogAttemptAt: new Date(), catalogError: null } });
    try {
      await this.conn.segmentations(accountId, () => this.budget.consumeCatalog(accountId));
      const syncedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.rdConnection.update({ where: { accountId }, data: { catalogSyncedAt: syncedAt, catalogError: null } });
        await tx.syncRun.update({ where, data: { status: 'completed', finishedAt: syncedAt, error: null } });
      });
    } catch (error) {
      const reauth = error instanceof RdProviderError && error.providerStatus === 401;
      const message = reauth ? REAUTH_MESSAGE : error instanceof RefreshBudgetExhaustedError ? BUDGET_MESSAGE : FAILURE_MESSAGE;
      if (reauth) await this.conn.marcarErro(accountId, error);
      await this.prisma.rdConnection.update({ where: { accountId }, data: { catalogError: message } });
      await this.prisma.syncRun.update({ where, data: { status: reauth ? 'paused' : 'partial', error: message } });
    }
  }
}
