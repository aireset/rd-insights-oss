ALTER TYPE "SyncKind" ADD VALUE 'catalog';
ALTER TABLE "RdConnection" ADD COLUMN "catalogBudgetDay" TIMESTAMP(3), ADD COLUMN "catalogRequestsUsed" INTEGER NOT NULL DEFAULT 0;
