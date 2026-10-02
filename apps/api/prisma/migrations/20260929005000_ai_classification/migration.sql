-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "aiCheckedAt" TIMESTAMP(3),
ADD COLUMN     "aiInputHash" TEXT,
ADD COLUMN     "aiModel" TEXT;

-- AlterTable
ALTER TABLE "LeadEvent" ADD COLUMN     "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "AiClassificationPolicy" (
    "accountId" TEXT NOT NULL,
    "inputPriceMicros" BIGINT NOT NULL,
    "outputPriceMicros" BIGINT NOT NULL,
    "cooldownUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiClassificationPolicy_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "AiClassificationTask" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiClassificationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiClassificationAttempt" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "reservedMicros" BIGINT NOT NULL,
    "chargedMicros" BIGINT NOT NULL,
    "costSource" TEXT NOT NULL DEFAULT 'reserved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiClassificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiClassificationTask_status_nextAttemptAt_idx" ON "AiClassificationTask"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiClassificationTask_accountId_leadId_inputHash_key" ON "AiClassificationTask"("accountId", "leadId", "inputHash");

-- CreateIndex
CREATE UNIQUE INDEX "AiClassificationTask_accountId_id_key" ON "AiClassificationTask"("accountId", "id");

-- CreateIndex
CREATE INDEX "AiClassificationAttempt_accountId_createdAt_idx" ON "AiClassificationAttempt"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_accountId_id_key" ON "Lead"("accountId", "id");

-- AddForeignKey
ALTER TABLE "AiClassificationPolicy" ADD CONSTRAINT "AiClassificationPolicy_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiClassificationTask" ADD CONSTRAINT "AiClassificationTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiClassificationTask" ADD CONSTRAINT "AiClassificationTask_accountId_leadId_fkey" FOREIGN KEY ("accountId", "leadId") REFERENCES "Lead"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiClassificationAttempt" ADD CONSTRAINT "AiClassificationAttempt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiClassificationAttempt" ADD CONSTRAINT "AiClassificationAttempt_accountId_taskId_fkey" FOREIGN KEY ("accountId", "taskId") REFERENCES "AiClassificationTask"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "LeadEvent_accountId_leadId_ingestedAt_idx" ON "LeadEvent"("accountId", "leadId", "ingestedAt");
ALTER TABLE "AiClassificationPolicy" ADD CONSTRAINT "AiClassificationPolicy_prices_check" CHECK ("inputPriceMicros" >= 0 AND "outputPriceMicros" >= 0);
ALTER TABLE "AiClassificationTask" ADD CONSTRAINT "AiClassificationTask_status_check" CHECK (status IN ('pending', 'processing', 'failed', 'completed', 'superseded'));
ALTER TABLE "AiClassificationAttempt" ADD CONSTRAINT "AiClassificationAttempt_cost_check" CHECK ("reservedMicros" >= 0 AND "chargedMicros" >= 0);
