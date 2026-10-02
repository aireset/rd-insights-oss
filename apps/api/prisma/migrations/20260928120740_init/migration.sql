-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'viewer');

-- CreateEnum
CREATE TYPE "RdConnectionStatus" AS ENUM ('pending', 'authorized', 'active', 'reauth_required', 'error');

-- CreateEnum
CREATE TYPE "LeadEventType" AS ENUM ('CONVERSION', 'OPPORTUNITY');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('full', 'delta', 'webhook', 'analytics');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RdConnection" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "segmentationId" TEXT,
    "segmentationName" TEXT,
    "webhookUuids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "RdConnectionStatus" NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "lastFullSyncAt" TIMESTAMP(3),
    "lastDeltaSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RdConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "rdUuid" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "jobTitle" TEXT,
    "company" TEXT,
    "website" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lifecycleStage" TEXT,
    "opportunity" BOOLEAN NOT NULL DEFAULT false,
    "fit" TEXT,
    "interest" INTEGER,
    "conversionsCount" INTEGER NOT NULL DEFAULT 0,
    "firstConversionAt" TIMESTAMP(3),
    "lastConversionAt" TIMESTAMP(3),
    "rdCreatedAt" TIMESTAMP(3),
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "raw" JSONB,
    "aiSummary" TEXT,
    "aiScore" TEXT,
    "aiReason" TEXT,
    "aiAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "LeadEventType" NOT NULL,
    "identifier" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "LeadEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_accountId_idx" ON "User"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RdConnection_accountId_key" ON "RdConnection"("accountId");

-- CreateIndex
CREATE INDEX "Lead_accountId_lastConversionAt_idx" ON "Lead"("accountId", "lastConversionAt");

-- CreateIndex
CREATE INDEX "Lead_accountId_lifecycleStage_idx" ON "Lead"("accountId", "lifecycleStage");

-- CreateIndex
CREATE INDEX "Lead_accountId_email_idx" ON "Lead"("accountId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_accountId_rdUuid_key" ON "Lead"("accountId", "rdUuid");

-- CreateIndex
CREATE INDEX "LeadEvent_accountId_occurredAt_idx" ON "LeadEvent"("accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "LeadEvent_accountId_identifier_idx" ON "LeadEvent"("accountId", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "LeadEvent_leadId_type_identifier_occurredAt_key" ON "LeadEvent"("leadId", "type", "identifier", "occurredAt");

-- CreateIndex
CREATE INDEX "SyncRun_accountId_startedAt_idx" ON "SyncRun"("accountId", "startedAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RdConnection" ADD CONSTRAINT "RdConnection_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
