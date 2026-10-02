CREATE TYPE "RdMembershipCoverage" AS ENUM ('unknown', 'partial', 'complete');

CREATE TABLE "RdSegmentation" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "rdId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "standard" BOOLEAN NOT NULL DEFAULT false,
  "selected" BOOLEAN NOT NULL DEFAULT false,
  "available" BOOLEAN NOT NULL DEFAULT true,
  "coverage" "RdMembershipCoverage" NOT NULL DEFAULT 'unknown',
  "lastScanAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RdSegmentation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RdSegmentation_accountId_rdId_key" ON "RdSegmentation"("accountId", "rdId");
CREATE INDEX "RdSegmentation_accountId_selected_idx" ON "RdSegmentation"("accountId", "selected");
CREATE INDEX "RdSegmentation_accountId_available_idx" ON "RdSegmentation"("accountId", "available");
ALTER TABLE "RdSegmentation" ADD CONSTRAINT "RdSegmentation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LeadSegmentMembership" (
  "accountId" TEXT NOT NULL,
  "segmentationRdId" TEXT NOT NULL,
  "leadRdUuid" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadSegmentMembership_pkey" PRIMARY KEY ("accountId", "segmentationRdId", "leadRdUuid")
);
CREATE INDEX "LeadSegmentMembership_accountId_leadRdUuid_idx" ON "LeadSegmentMembership"("accountId", "leadRdUuid");
ALTER TABLE "LeadSegmentMembership" ADD CONSTRAINT "LeadSegmentMembership_accountId_segmentationRdId_fkey" FOREIGN KEY ("accountId", "segmentationRdId") REFERENCES "RdSegmentation"("accountId", "rdId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadSegmentMembership" ADD CONSTRAINT "LeadSegmentMembership_accountId_leadRdUuid_fkey" FOREIGN KEY ("accountId", "leadRdUuid") REFERENCES "Lead"("accountId", "rdUuid") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SyncRun" ADD COLUMN "segmentId" TEXT;
CREATE INDEX "SyncRun_accountId_segmentId_startedAt_idx" ON "SyncRun"("accountId", "segmentId", "startedAt");

-- Carry forward only the saved selection. Historical lead memberships remain unknown.
INSERT INTO "RdSegmentation" ("id", "accountId", "rdId", "name", "selected", "available", "coverage", "updatedAt")
SELECT gen_random_uuid()::text, "accountId", "segmentationId", COALESCE("segmentationName", "segmentationId"), true, true, 'unknown', CURRENT_TIMESTAMP
FROM "RdConnection"
WHERE "segmentationId" IS NOT NULL
ON CONFLICT ("accountId", "rdId") DO UPDATE SET "selected" = true;
