CREATE TABLE "InviteToken" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InviteToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InviteToken_email_key" ON "InviteToken"("email");
CREATE UNIQUE INDEX "InviteToken_tokenHash_key" ON "InviteToken"("tokenHash");
CREATE INDEX "InviteToken_accountId_usedAt_expiresAt_idx" ON "InviteToken"("accountId", "usedAt", "expiresAt");
CREATE UNIQUE INDEX "User_id_accountId_key" ON "User"("id", "accountId");

ALTER TABLE "InviteToken" ADD CONSTRAINT "InviteToken_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InviteToken" ADD CONSTRAINT "InviteToken_createdById_accountId_fkey"
  FOREIGN KEY ("createdById", "accountId") REFERENCES "User"("id", "accountId") ON DELETE RESTRICT ON UPDATE CASCADE;
