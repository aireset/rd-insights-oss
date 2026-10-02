CREATE TABLE "RdAnalyticsCache" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "data" JSONB,
    "fetchedAt" TIMESTAMP(3),
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RdAnalyticsCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RdAnalyticsCache_accountId_type_period_key" ON "RdAnalyticsCache"("accountId", "type", "period");
CREATE INDEX "RdAnalyticsCache_accountId_fetchedAt_idx" ON "RdAnalyticsCache"("accountId", "fetchedAt");
ALTER TABLE "RdAnalyticsCache" ADD CONSTRAINT "RdAnalyticsCache_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
