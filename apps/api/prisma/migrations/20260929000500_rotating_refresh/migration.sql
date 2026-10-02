ALTER TYPE "SyncKind" ADD VALUE 'refresh';
ALTER TABLE "RdConnection"
  ADD COLUMN "lastRefreshAt" TIMESTAMP(3),
  ADD COLUMN "refreshDailyBudget" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN "refreshBudgetDay" TIMESTAMP(3),
  ADD COLUMN "refreshRequestsUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "catalogAttemptAt" TIMESTAMP(3),
  ADD COLUMN "catalogSyncedAt" TIMESTAMP(3),
  ADD COLUMN "catalogError" TEXT;
ALTER TABLE "RdConnection" ADD CONSTRAINT "RdConnection_refreshDailyBudget_check" CHECK ("refreshDailyBudget" >= 1), ADD CONSTRAINT "RdConnection_refreshRequestsUsed_check" CHECK ("refreshRequestsUsed" >= 0);
