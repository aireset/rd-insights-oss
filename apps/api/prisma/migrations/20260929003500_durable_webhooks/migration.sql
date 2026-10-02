ALTER TABLE "RdConnection" ADD COLUMN "webhookTokenHash" TEXT,
  ADD COLUMN "webhookRegisteredAt" TIMESTAMP(3), ADD COLUMN "webhookError" TEXT;
ALTER TABLE "Lead" ADD COLUMN "webhookProfileAt" TIMESTAMP(3);
CREATE TABLE "WebhookLog" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "rdUuid" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "lastError" TEXT,
  CONSTRAINT "WebhookLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebhookLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WebhookLog_status_check" CHECK ("status" IN ('pending', 'completed', 'failed')),
  CONSTRAINT "WebhookLog_attempts_check" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX "WebhookLog_accountId_eventKey_key" ON "WebhookLog"("accountId", "eventKey");
CREATE INDEX "WebhookLog_status_receivedAt_idx" ON "WebhookLog"("status", "receivedAt");
CREATE INDEX "WebhookLog_accountId_receivedAt_idx" ON "WebhookLog"("accountId", "receivedAt");
