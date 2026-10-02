CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SavedView_accountId_userId_updatedAt_idx" ON "SavedView"("accountId", "userId", "updatedAt");

ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
