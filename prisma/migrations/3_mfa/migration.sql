-- Multi-factor authentication: passkeys, backup codes, and the short-lived
-- ceremonies that register them and check them at sign-in.
--
-- Written out by hand rather than diffed: `2_pascal_case` deliberately left
-- index and constraint names in snake_case (see its header), which Prisma reads
-- as drift, so its generated migrations rewrite every name. The three tables
-- below are new, so there is nothing to rename first.

-- AlterTable
ALTER TABLE "Sessions" ADD COLUMN "ReauthAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "MfaChallenges" (
    "Id" BIGSERIAL NOT NULL,
    "UserId" BIGINT NOT NULL,
    "Kind" TEXT NOT NULL,
    "SecretHash" TEXT,
    "Challenge" TEXT,
    "ExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "CreatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaChallenges_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "MfaBackupCodes" (
    "Id" BIGSERIAL NOT NULL,
    "UserId" BIGINT NOT NULL,
    "CodeHash" TEXT NOT NULL,
    "UsedAt" TIMESTAMPTZ(6),
    "CreatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaBackupCodes_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "Passkeys" (
    "Id" BIGSERIAL NOT NULL,
    "UserId" BIGINT NOT NULL,
    "CredentialId" TEXT NOT NULL,
    "PublicKey" TEXT NOT NULL,
    "Counter" BIGINT NOT NULL DEFAULT 0,
    "Label" TEXT NOT NULL,
    "Transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "CreatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "LastUsedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Passkeys_pkey" PRIMARY KEY ("Id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaChallenges_SecretHash_Kind_key" ON "MfaChallenges"("SecretHash", "Kind");

-- CreateIndex
CREATE INDEX "MfaChallenges_ExpiresAt_idx" ON "MfaChallenges"("ExpiresAt");

-- CreateIndex
CREATE INDEX "MfaChallenges_UserId_Kind_idx" ON "MfaChallenges"("UserId", "Kind");

-- CreateIndex
CREATE UNIQUE INDEX "MfaBackupCodes_CodeHash_key" ON "MfaBackupCodes"("CodeHash");

-- CreateIndex
CREATE INDEX "MfaBackupCodes_UserId_idx" ON "MfaBackupCodes"("UserId");

-- CreateIndex
CREATE UNIQUE INDEX "Passkeys_CredentialId_key" ON "Passkeys"("CredentialId");

-- CreateIndex
CREATE INDEX "Passkeys_UserId_idx" ON "Passkeys"("UserId");

-- AddForeignKey
ALTER TABLE "MfaChallenges" ADD CONSTRAINT "MfaChallenges_UserId_fkey" FOREIGN KEY ("UserId") REFERENCES "Users"("Id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "MfaBackupCodes" ADD CONSTRAINT "MfaBackupCodes_UserId_fkey" FOREIGN KEY ("UserId") REFERENCES "Users"("Id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Passkeys" ADD CONSTRAINT "Passkeys_UserId_fkey" FOREIGN KEY ("UserId") REFERENCES "Users"("Id") ON DELETE CASCADE ON UPDATE NO ACTION;
