import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export class RefreshBudgetExhaustedError extends Error {
  constructor() { super('Orçamento diário de atualização esgotado; retomada no próximo lote.'); }
}

@Injectable()
export class RdRefreshBudgetService {
  constructor(private readonly prisma: PrismaService) {}
  async consumeCatalog(accountId: string): Promise<void> {
    const day = new Date(new Date().toISOString().slice(0, 10));
    const count = await this.prisma.$executeRaw`
      UPDATE "RdConnection"
      SET "catalogRequestsUsed" = CASE WHEN "catalogBudgetDay" >= ${day} THEN "catalogRequestsUsed" + 1 ELSE 1 END,
          "catalogBudgetDay" = ${day}
      WHERE "accountId" = ${accountId}
        AND ("catalogBudgetDay" IS NULL OR "catalogBudgetDay" < ${day} OR "catalogRequestsUsed" < 100)
    `;
    if (!count) throw new RefreshBudgetExhaustedError();
  }
  async consume(accountId: string): Promise<void> {
    const day = new Date(new Date().toISOString().slice(0, 10));
    const count = await this.prisma.$executeRaw`
      UPDATE "RdConnection"
      SET "refreshRequestsUsed" = CASE WHEN "refreshBudgetDay" >= ${day} THEN "refreshRequestsUsed" + 1 ELSE 1 END,
          "refreshBudgetDay" = ${day}
      WHERE "accountId" = ${accountId}
        AND ("refreshBudgetDay" IS NULL OR "refreshBudgetDay" < ${day} OR "refreshRequestsUsed" < "refreshDailyBudget")
    `;
    if (!count) throw new RefreshBudgetExhaustedError();
  }
}
