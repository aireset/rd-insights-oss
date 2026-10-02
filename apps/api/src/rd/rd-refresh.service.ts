import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RdConnectionService } from './rd-connection.service';
import { RdSyncService } from './rd-sync.service';
import { RdRefreshBudgetService, RefreshBudgetExhaustedError } from './rd-refresh-budget.service';
import { RdProviderError } from '../common/errors';
import type { RdEvent } from './rd-mapper';

type RefreshStep = 'details' | 'funnel' | 'conversions' | 'opportunities' | 'complete';
type RefreshStats = {
  cutoffAt: string;
  segmentIds: string[];
  afterLeadId: string | null;
  currentLeadId: string | null;
  currentUuid: string | null;
  step: RefreshStep;
  page: number;
  leadsCompleted: number;
};
const PARTIAL_ERROR = 'Falha parcial na atualização RD; tente retomar.';
const BUDGET_ERROR = 'Orçamento diário esgotado; atualização será retomada no próximo ciclo.';
const PAUSED_ERROR = 'Atualização pausada; reconecte a conta ou reative uma segmentação.';
class RefreshPausedError extends Error {}
class RefreshLeadIneligibleError extends Error {}

@Injectable()
export class RdRefreshService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conn: RdConnectionService,
    private readonly sync: RdSyncService,
    private readonly budget: RdRefreshBudgetService,
  ) {}

  async run(accountId: string, runId: string): Promise<void> {
    const run = await this.prisma.syncRun.findFirst({ where: { id: runId, accountId, kind: 'refresh' } });
    if (!run || run.finishedAt) return;
    let stats = (run.stats ?? {}) as Partial<RefreshStats>;
    if (!stats.cutoffAt || !Array.isArray(stats.segmentIds)) {
      const segments = await this.prisma.rdSegmentation.findMany({ where: { accountId, selected: true, available: true }, select: { rdId: true }, orderBy: { rdId: 'asc' } });
      stats = { cutoffAt: new Date().toISOString(), segmentIds: segments.map((segment) => segment.rdId), afterLeadId: null, currentLeadId: null, currentUuid: null, step: 'details', page: 1, leadsCompleted: 0 };
    } else {
      stats = { afterLeadId: null, currentLeadId: null, currentUuid: null, step: 'details', page: 1, leadsCompleted: 0, ...stats };
    }
    const persist = (data: Record<string, unknown> = {}) => this.prisma.syncRun.update({ where: { id: runId, accountId }, data: { stats, ...data } });
    const eligible = async (): Promise<boolean> => {
      const connection = await this.prisma.rdConnection.findUnique({ where: { accountId }, select: { status: true } });
      if (!connection || !['active', 'error'].includes(connection.status)) return false;
      if (!stats.segmentIds!.length) return true;
      return (await this.prisma.rdSegmentation.count({ where: { accountId, rdId: { in: stats.segmentIds }, selected: true, available: true } })) > 0;
    };
    const currentLeadEligible = async (): Promise<boolean> => {
      if (!stats.currentLeadId) return true;
      return !!(await this.prisma.leadSegmentMembership.findFirst({ where: {
        accountId,
        leadRdUuid: stats.currentUuid!,
        segmentationRdId: { in: stats.segmentIds },
        firstSeenAt: { lte: new Date(stats.cutoffAt!) },
        segmentation: { selected: true, available: true },
      }, select: { leadRdUuid: true } }));
    };
    const pause = async () => { await persist({ status: 'paused', error: PAUSED_ERROR }); };
    const checkpoint = async () => { await persist({ status: 'running', error: null }); };
    const skipCurrentLead = async () => {
      stats.afterLeadId = stats.currentLeadId;
      stats.currentLeadId = null;
      stats.currentUuid = null;
      stats.step = 'details';
      stats.page = 1;
      await checkpoint();
    };
    const runStep = async (operation: () => Promise<unknown>): Promise<boolean> => {
      try { await operation(); return true; }
      catch (error) {
        if (!(error instanceof RefreshLeadIneligibleError)) throw error;
        await skipCurrentLead();
        return false;
      }
    };
    await checkpoint();
    try {
      const client = await this.conn.client(accountId, async () => {
        if (!await eligible()) throw new RefreshPausedError();
        if (!await currentLeadEligible()) throw new RefreshLeadIneligibleError();
        await this.budget.consume(accountId);
      });
      for (;;) {
        if (!await eligible()) { await pause(); return; }
        if (stats.currentLeadId && !await currentLeadEligible()) { await skipCurrentLead(); continue; }
        if (!stats.currentLeadId) {
          const lead = await this.prisma.lead.findFirst({
            where: {
              accountId,
              ...(stats.afterLeadId ? { id: { gt: stats.afterLeadId } } : {}),
              segmentMemberships: { some: {
                segmentationRdId: { in: stats.segmentIds },
                firstSeenAt: { lte: new Date(stats.cutoffAt!) },
                segmentation: { selected: true, available: true },
              } },
            },
            orderBy: { id: 'asc' }, select: { id: true, rdUuid: true },
          });
          if (!lead) {
            const completedAt = new Date();
            await this.prisma.$transaction(async (tx) => {
              const connection = await tx.rdConnection.findUnique({ where: { accountId }, select: { status: true } });
              const selected = !stats.segmentIds!.length || (await tx.rdSegmentation.count({ where: { accountId, rdId: { in: stats.segmentIds }, selected: true, available: true } })) > 0;
              if (!connection || !['active', 'error'].includes(connection.status) || !selected) throw new RefreshPausedError();
              await tx.syncRun.update({ where: { id: runId, accountId }, data: { status: 'completed', finishedAt: completedAt, error: null, stats } });
              try {
                await tx.rdConnection.update({ where: { accountId, status: { in: ['active', 'error'] } }, data: { lastRefreshAt: completedAt } });
              } catch (error) {
                if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025') throw new RefreshPausedError();
                throw error;
              }
            });
            return;
          }
          stats.currentLeadId = lead.id;
          stats.currentUuid = lead.rdUuid;
          stats.step = 'details';
          stats.page = 1;
          await checkpoint();
        }
        if (stats.step === 'details') {
          if (!await runStep(() => this.sync.refreshDetails(accountId, client, stats.currentUuid!))) continue;
          stats.step = 'funnel';
          await checkpoint();
        } else if (stats.step === 'funnel') {
          if (!await runStep(() => this.sync.refreshFunnel(accountId, client, stats.currentUuid!))) continue;
          stats.step = 'conversions';
          stats.page = 1;
          await checkpoint();
        } else if (stats.step === 'conversions' || stats.step === 'opportunities') {
          const type: RdEvent['event_type'] = stats.step === 'conversions' ? 'CONVERSION' : 'OPPORTUNITY';
          let more = false;
          if (!await runStep(async () => { more = await this.sync.refreshEventPage(accountId, client, stats.currentUuid!, type, stats.page!); })) continue;
          if (more) stats.page!++;
          else if (stats.step === 'conversions') { stats.step = 'opportunities'; stats.page = 1; }
          else stats.step = 'complete';
          await checkpoint();
        } else {
          await this.sync.completeRefreshHistory(accountId, stats.currentUuid!, true);
          stats.afterLeadId = stats.currentLeadId;
          stats.currentLeadId = null;
          stats.currentUuid = null;
          stats.step = 'details';
          stats.page = 1;
          stats.leadsCompleted!++;
          await checkpoint();
        }
      }
    } catch (error) {
      if (error instanceof RefreshPausedError) { await pause(); return; }
      if (error instanceof RefreshLeadIneligibleError) { await skipCurrentLead(); return this.run(accountId, runId); }
      if (error instanceof RdProviderError && error.providerStatus === 401) {
        await this.conn.marcarErro(accountId, error);
        await persist({ status: 'paused', error: 'Autorize novamente a conexão RD para retomar.' });
        return;
      }
      const exhausted = error instanceof RefreshBudgetExhaustedError;
      await persist({ status: 'partial', error: exhausted ? BUDGET_ERROR : PARTIAL_ERROR });
      if (!exhausted) throw error;
    }
  }
}
