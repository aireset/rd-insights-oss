import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RdConnectionService } from './rd-connection.service';
import { RdProviderError } from '../common/errors';

const PERIOD_DAYS = 30;
const CACHE_MS = 24 * 60 * 60 * 1000;
const TYPES = ['conversions', 'funnel'] as const;
const safeError = (error: unknown): string => {
  const status = error instanceof RdProviderError ? error.providerStatus : undefined;
  if (status === 401) return 'RD recusou o acesso. Confira a autorização e a disponibilidade no plano.';
  if (status === 403) return 'Analytics indisponível para as permissões ou plano desta conta.';
  if (status === 429) return 'Limite de chamadas RD atingido. A próxima coleta tentará novamente.';
  return 'Não foi possível atualizar os analytics RD. A próxima coleta tentará novamente.';
};

@Injectable()
export class RdAnalyticsService {
  private readonly log = new Logger(RdAnalyticsService.name);
  constructor(private readonly prisma: PrismaService, private readonly connection: RdConnectionService) {}

  async dashboard(accountId: string) {
    const rows = await this.prisma.rdAnalyticsCache.findMany({ where: { accountId, period: PERIOD_DAYS } });
    return Object.fromEntries(TYPES.map((type) => {
      const row = rows.find((item) => item.type === type);
      return [type, { data: row?.data ?? null, fetchedAt: row?.fetchedAt?.toISOString() ?? null, error: row?.error ?? null, stale: !row?.fetchedAt || Date.now() - row.fetchedAt.getTime() >= CACHE_MS, period: PERIOD_DAYS, scope: 'global' }];
    }));
  }

  async refresh(accountId: string): Promise<void> {
    const end = new Date();
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - PERIOD_DAYS + 1));
    const params = { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) };
    const client = await this.connection.client(accountId);
    for (const type of TYPES) {
      const previous = await this.prisma.rdAnalyticsCache.findUnique({ where: { accountId_type_period: { accountId, type, period: PERIOD_DAYS } } });
      if (previous?.fetchedAt && Date.now() - previous.fetchedAt.getTime() < CACHE_MS) continue;
      try {
        const response = await client.get<unknown>(`/platform/analytics/${type}`, type === 'funnel' ? { ...params, grouped_by: 'daily' } : params);
        if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('invalid_response');
        const data = { ...response, query_date: params } as Prisma.InputJsonValue;
        await this.prisma.rdAnalyticsCache.upsert({
          where: { accountId_type_period: { accountId, type, period: PERIOD_DAYS } },
          create: { accountId, type, period: PERIOD_DAYS, data: data as Prisma.InputJsonValue, fetchedAt: new Date(), error: null },
          update: { data: data as Prisma.InputJsonValue, fetchedAt: new Date(), error: null },
        });
      } catch (error) {
        const message = safeError(error);
        this.log.warn(`analytics RD ${type}: ${message}`);
        await this.prisma.rdAnalyticsCache.upsert({
          where: { accountId_type_period: { accountId, type, period: PERIOD_DAYS } },
          create: { accountId, type, period: PERIOD_DAYS, error: message.slice(0, 500) },
          update: { error: message.slice(0, 500) },
        });
      }
    }
  }

  async refreshAll(): Promise<void> {
    let cursor = '';
    while (true) {
      const accounts = await this.prisma.account.findMany({ where: { id: { gt: cursor }, rd: { is: { status: { in: ['active', 'error'] } } } }, select: { id: true }, orderBy: { id: 'asc' }, take: 100 });
      if (!accounts.length) return;
      for (const { id } of accounts) {
        cursor = id;
        try { await this.refresh(id); }
        catch (error) {
          const message = safeError(error);
          for (const type of TYPES) await this.prisma.rdAnalyticsCache.upsert({ where: { accountId_type_period: { accountId: id, type, period: PERIOD_DAYS } }, create: { accountId: id, type, period: PERIOD_DAYS, error: message.slice(0, 500) }, update: { error: message.slice(0, 500) } });
        }
      }
      if (accounts.length < 100) return;
    }
  }
}
