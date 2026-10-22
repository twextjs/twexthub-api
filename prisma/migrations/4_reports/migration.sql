-- User accounts, extensions, and organizations can be reported for manual
-- moderator review.
--
-- A report names its target by address and links to the target itself: the
-- reported account by its id, the reported extension by the row in
-- "Extensions" that gives the extension its identity. An extension is an
-- address rather than a row -- its versions live in "Versions" -- so the
-- identity table is what gives a report something to point at.
--
-- Every link is cleared rather than cascading when the target goes away, so a
-- report outlives what it is about and still says what was reported, and
-- nothing is blocked on the way: deleting a reported account or extension is
-- still a moderator's decision to take, and filing a report never acts on the
-- target by itself. The reporter and the reviewer are linked the same way, so
-- neither a report nor a decision disappears with the account behind it.
--
-- The unique index is partial: it covers the open reports only, so a reporter
-- cannot pile a second complaint about the same target onto the queue while
-- the first one is still waiting, and can file a fresh one once it has been
-- decided.

-- CreateTable
CREATE TABLE "Extensions" (
    "Id" BIGSERIAL NOT NULL,
    "NamespaceId" BIGINT,
    "Namespace" TEXT NOT NULL,
    "ExtensionId" TEXT NOT NULL,
    "CreatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Extensions_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "Reports" (
    "Id" BIGSERIAL NOT NULL,
    "ReporterId" BIGINT,
    "ReporterNamespace" TEXT NOT NULL,
    "TargetType" TEXT NOT NULL,
    "TargetNamespace" TEXT NOT NULL,
    "TargetExtensionId" TEXT NOT NULL DEFAULT '',
    "TargetAccountId" BIGINT,
    "TargetExtensionRefId" BIGINT,
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
CREATE UNIQUE INDEX "Extensions_Namespace_ExtensionId_key" ON "Extensions"("Namespace", "ExtensionId");

-- CreateIndex
CREATE INDEX "extensions_namespace_id_idx" ON "Extensions"("NamespaceId");

-- CreateIndex
CREATE INDEX "reports_status_idx" ON "Reports"("Status", "Id");

-- CreateIndex
CREATE INDEX "reports_target_idx" ON "Reports"("TargetType", "TargetNamespace", "TargetExtensionId");

-- CreateIndex
CREATE UNIQUE INDEX "reports_open_unique_idx" ON "Reports"("ReporterId", "TargetType", "TargetNamespace", "TargetExtensionId") WHERE ("Status" = 'open');

-- AddForeignKey
ALTER TABLE "Extensions" ADD CONSTRAINT "Extensions_NamespaceId_fkey" FOREIGN KEY ("NamespaceId") REFERENCES "Users"("Id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Reports" ADD CONSTRAINT "Reports_ReporterId_fkey" FOREIGN KEY ("ReporterId") REFERENCES "Users"("Id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Reports" ADD CONSTRAINT "Reports_ReviewedBy_fkey" FOREIGN KEY ("ReviewedBy") REFERENCES "Users"("Id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Reports" ADD CONSTRAINT "Reports_TargetAccountId_fkey" FOREIGN KEY ("TargetAccountId") REFERENCES "Users"("Id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Reports" ADD CONSTRAINT "Reports_TargetExtensionRefId_fkey" FOREIGN KEY ("TargetExtensionRefId") REFERENCES "Extensions"("Id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- The extensions that already exist get their identity row, so a report filed
-- about one of them has something to point at. The identity belongs to the
-- account holding the address; an extension whose namespace account is gone
-- keeps the row without the link.
INSERT INTO "Extensions" ("NamespaceId", "Namespace", "ExtensionId", "CreatedAt")
SELECT u."Id", v."Namespace", v."ExtensionId", MIN(v."CreatedAt")
FROM "Versions" v
LEFT JOIN "Users" u ON u."Namespace" = v."Namespace"
GROUP BY u."Id", v."Namespace", v."ExtensionId";
