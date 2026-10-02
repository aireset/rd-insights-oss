CREATE TABLE "UserTwoFactor" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "lastUsedStep" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserTwoFactor_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "UserTwoFactorRecoveryCode" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserTwoFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserTwoFactor_userId_accountId_key" ON "UserTwoFactor"("userId", "accountId");
CREATE INDEX "UserTwoFactor_accountId_idx" ON "UserTwoFactor"("accountId");
CREATE UNIQUE INDEX "UserTwoFactorRecoveryCode_accountId_userId_codeHash_key" ON "UserTwoFactorRecoveryCode"("accountId", "userId", "codeHash");
CREATE INDEX "UserTwoFactorRecoveryCode_accountId_userId_idx" ON "UserTwoFactorRecoveryCode"("accountId", "userId");
ALTER TABLE "UserTwoFactor" ADD CONSTRAINT "UserTwoFactor_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserTwoFactor" ADD CONSTRAINT "UserTwoFactor_userId_accountId_fkey" FOREIGN KEY ("userId", "accountId") REFERENCES "User"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserTwoFactorRecoveryCode" ADD CONSTRAINT "UserTwoFactorRecoveryCode_userId_accountId_fkey" FOREIGN KEY ("userId", "accountId") REFERENCES "UserTwoFactor"("userId", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;
