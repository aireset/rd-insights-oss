ALTER TABLE "RdSegmentation" ADD COLUMN "lastDeltaSyncAt" TIMESTAMP(3);
ALTER TABLE "LeadSegmentMembership" ADD COLUMN "eventsPending" BOOLEAN NOT NULL DEFAULT false;
