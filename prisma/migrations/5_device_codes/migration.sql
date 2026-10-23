-- Device authorization codes for CLI sign-in: the secret a client polls with,
-- the short code a person types into a browser, and the account that approved
-- it. Written out by hand for the same reason as 3_mfa: the earlier rename
-- migration left constraint names in snake_case, which a diffed migration
-- would rewrite.

-- CreateTable
CREATE TABLE "DeviceCodes" (
    "Id" BIGSERIAL NOT NULL,
    "DeviceCodeHash" TEXT NOT NULL,
    "UserCodeHash" TEXT NOT NULL,
    "ClientName" TEXT NOT NULL,
    "UserId" BIGINT,
    "ApprovedAt" TIMESTAMPTZ(6),
    "DeniedAt" TIMESTAMPTZ(6),
    "LastPolledAt" TIMESTAMPTZ(6),
    "CreatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ExpiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DeviceCodes_pkey" PRIMARY KEY ("Id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCodes_DeviceCodeHash_key" ON "DeviceCodes"("DeviceCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCodes_UserCodeHash_key" ON "DeviceCodes"("UserCodeHash");

-- CreateIndex
CREATE INDEX "DeviceCodes_ExpiresAt_idx" ON "DeviceCodes"("ExpiresAt");

-- CreateIndex
CREATE INDEX "DeviceCodes_UserId_idx" ON "DeviceCodes"("UserId");

-- AddForeignKey
ALTER TABLE "DeviceCodes" ADD CONSTRAINT "DeviceCodes_UserId_fkey" FOREIGN KEY ("UserId") REFERENCES "Users"("Id") ON DELETE CASCADE ON UPDATE NO ACTION;
