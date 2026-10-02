CREATE TABLE "AiConfig" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openai-compatible',
    "baseUrl" TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
    "model" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "monthlyBudgetCents" INTEGER NOT NULL DEFAULT 1000,
    "requestsPerMinute" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiLog" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costMicros" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiConfig_accountId_key" ON "AiConfig"("accountId");
CREATE INDEX "AiConfig_accountId_enabled_idx" ON "AiConfig"("accountId", "enabled");
CREATE INDEX "AiLog_accountId_createdAt_idx" ON "AiLog"("accountId", "createdAt");
CREATE INDEX "AiLog_accountId_feature_createdAt_idx" ON "AiLog"("accountId", "feature", "createdAt");

ALTER TABLE "AiConfig" ADD CONSTRAINT "AiConfig_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiLog" ADD CONSTRAINT "AiLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
