-- User accounts, extensions, and organizations can be reported for
-- manual moderator review.

CREATE TABLE "Reports" (
    "Id" BIGSERIAL NOT NULL,
    "ReporterId" BIGINT NOT NULL,
    "TargetType" TEXT NOT NULL,
    "TargetNamespace" TEXT,
    "TargetExtensionId" TEXT,
    "TargetUserId" BIGINT,
    "Reason" TEXT NOT NULL,
    "Description" TEXT NOT NULL,
    "Status" TEXT NOT NULL DEFAULT 'open',
    "ReviewedBy" BIGINT,
    "ReviewedAt" TIMESTAMPTZ(6),
    "ResolutionNote" TEXT,
    "CreatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reports_pkey" PRIMARY KEY ("Id")
);

ALTER TABLE "Reports" ADD CONSTRAINT "Reports_ReporterId_fkey" FOREIGN KEY ("ReporterId") REFERENCES "Users"("Id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "Reports" ADD CONSTRAINT "Reports_ReviewedBy_fkey" FOREIGN KEY ("ReviewedBy") REFERENCES "Users"("Id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX "Reports_Status_CreatedAt_idx" ON "Reports"("Status", "CreatedAt");
CREATE INDEX "Reports_ReporterId_idx" ON "Reports"("ReporterId");
CREATE INDEX "Reports_TargetType_TargetNamespace_TargetExtensionId_idx" ON "Reports"("TargetType", "TargetNamespace", "TargetExtensionId");
CREATE INDEX "Reports_TargetUserId_idx" ON "Reports"("TargetUserId");
