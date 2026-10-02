CREATE TABLE "DailyInsightSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "timezone" TEXT NOT NULL,
    "contextText" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "comparison" JSONB NOT NULL,
    "coverage" JSONB NOT NULL,
    "freshness" JSONB NOT NULL,
    "bullets" JSONB,
    "model" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DailyInsightSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailyInsightSnapshot_accountId_snapshotDate_scopeKey_key" ON "DailyInsightSnapshot"("accountId", "snapshotDate", "scopeKey");
CREATE INDEX "DailyInsightSnapshot_accountId_snapshotDate_idx" ON "DailyInsightSnapshot"("accountId", "snapshotDate");
ALTER TABLE "DailyInsightSnapshot" ADD CONSTRAINT "DailyInsightSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
