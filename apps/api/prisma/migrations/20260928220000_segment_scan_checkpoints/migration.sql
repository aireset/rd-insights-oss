ALTER TABLE "Lead" ADD COLUMN "enrichedAt" TIMESTAMP(3), ADD COLUMN "historySyncedAt" TIMESTAMP(3);
ALTER TABLE "LeadSegmentMembership" ADD COLUMN "lastSeenRunId" TEXT, ADD COLUMN "lastMissingRunId" TEXT, ADD COLUMN "missingScans" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SyncRun" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'queued';
UPDATE "SyncRun" SET "status" = CASE WHEN "finishedAt" IS NOT NULL AND "error" IS NULL THEN 'completed' WHEN "error" IS NOT NULL THEN 'partial' ELSE 'queued' END;
