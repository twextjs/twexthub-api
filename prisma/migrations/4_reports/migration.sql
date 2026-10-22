-- User accounts, extensions, and organizations can be reported for manual
-- moderator review.
--
-- The report names its target by address rather than by a foreign key, so a
-- report outlives what it is about: deleting the reported account or the
-- reported extension leaves the report standing, still saying what was
-- reported. The reporter and the reviewer are the two parts that are linked to
-- accounts, and both links are cleared rather than cascading, so neither a
-- report nor a decision disappears with the account behind it.
--
-- The unique index is partial: it covers the open reports only, so a reporter
-- cannot pile a second complaint about the same target onto the queue while
-- the first one is still waiting, and can file a fresh one once it has been
-- decided.

-- CreateTable
CREATE TABLE "Reports" (
    "Id" BIGSERIAL NOT NULL,
    "ReporterId" BIGINT,
    "ReporterNamespace" TEXT NOT NULL,
    "TargetType" TEXT NOT NULL,
    "TargetNamespace" TEXT NOT NULL,
    "TargetExtensionId" TEXT NOT NULL DEFAULT '',
    "Reason" TEXT NOT NULL,
    "Description" TEXT NOT NULL,
    "Status" TEXT NOT NULL DEFAULT 'open',
    "ReviewedBy" BIGINT,
    "ReviewedByNamespace" TEXT,
    "ReviewedAt" TIMESTAMPTZ(6),
    "ResolutionNote" TEXT,
    "CreatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reports_pkey" PRIMARY KEY ("Id")
);

-- CreateIndex
CREATE INDEX "reports_status_idx" ON "Reports"("Status", "Id");

-- CreateIndex
CREATE INDEX "reports_target_idx" ON "Reports"("TargetType", "TargetNamespace", "TargetExtensionId");

-- CreateIndex
CREATE UNIQUE INDEX "reports_open_unique_idx" ON "Reports"("ReporterId", "TargetType", "TargetNamespace", "TargetExtensionId") WHERE ("Status" = 'open');

-- AddForeignKey
ALTER TABLE "Reports" ADD CONSTRAINT "Reports_ReporterId_fkey" FOREIGN KEY ("ReporterId") REFERENCES "Users"("Id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Reports" ADD CONSTRAINT "Reports_ReviewedBy_fkey" FOREIGN KEY ("ReviewedBy") REFERENCES "Users"("Id") ON DELETE SET NULL ON UPDATE NO ACTION;
