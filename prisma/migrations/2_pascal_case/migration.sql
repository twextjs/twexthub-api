-- Switch every application table and column from snake_case to PascalCase.
--
-- Index, constraint, trigger and sequence names are deliberately left alone:
-- #43 covers rows, columns and tables, and none of those names is part of the
-- data. Postgres rewrites the parts it derives from a column (indexes, foreign
-- keys, check constraints, defaults and partial-index predicates) when the
-- column is renamed, so only the plpgsql bodies below have to be written out
-- again by hand.
--
-- `schema_migrations` is not here: it is managed by the bootstrap in
-- `src/db.js`, which folds the legacy snake_case table into `SchemaMigrations`
-- the same way, before this migration ever runs.

-- RenameTable
ALTER TABLE "public"."audit_log" RENAME TO "AuditLog";
ALTER TABLE "public"."automation_tokens" RENAME TO "AutomationTokens";
ALTER TABLE "public"."dist_tags" RENAME TO "DistTags";
ALTER TABLE "public"."download_events" RENAME TO "DownloadEvents";
ALTER TABLE "public"."extension_daily_downloads" RENAME TO "ExtensionDailyDownloads";
ALTER TABLE "public"."extension_owner_invites" RENAME TO "ExtensionOwnerInvites";
ALTER TABLE "public"."extension_owners" RENAME TO "ExtensionOwners";
ALTER TABLE "public"."extension_redirects" RENAME TO "ExtensionRedirects";
ALTER TABLE "public"."extension_transfers" RENAME TO "ExtensionTransfers";
ALTER TABLE "public"."extension_version_daily_downloads" RENAME TO "ExtensionVersionDailyDownloads";
ALTER TABLE "public"."legal_documents" RENAME TO "LegalDocuments";
ALTER TABLE "public"."notifications" RENAME TO "Notifications";
ALTER TABLE "public"."oidc_flows" RENAME TO "OidcFlows";
ALTER TABLE "public"."organization_owners" RENAME TO "OrganizationOwners";
ALTER TABLE "public"."rate_limit_entries" RENAME TO "RateLimitEntries";
ALTER TABLE "public"."sessions" RENAME TO "Sessions";
ALTER TABLE "public"."user_identities" RENAME TO "UserIdentities";
ALTER TABLE "public"."users" RENAME TO "Users";
ALTER TABLE "public"."versions" RENAME TO "Versions";
ALTER TABLE "public"."webhook_deliveries" RENAME TO "WebhookDeliveries";
ALTER TABLE "public"."webhooks" RENAME TO "Webhooks";

-- RenameColumn
ALTER TABLE "public"."AuditLog" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."AuditLog" RENAME COLUMN "actor_id" TO "ActorId";
ALTER TABLE "public"."AuditLog" RENAME COLUMN "actor_namespace" TO "ActorNamespace";
ALTER TABLE "public"."AuditLog" RENAME COLUMN "action" TO "Action";
ALTER TABLE "public"."AuditLog" RENAME COLUMN "target_namespace" TO "TargetNamespace";
ALTER TABLE "public"."AuditLog" RENAME COLUMN "target_extension_id" TO "TargetExtensionId";
ALTER TABLE "public"."AuditLog" RENAME COLUMN "target_version" TO "TargetVersion";
ALTER TABLE "public"."AuditLog" RENAME COLUMN "detail" TO "Detail";
ALTER TABLE "public"."AuditLog" RENAME COLUMN "created_at" TO "CreatedAt";

ALTER TABLE "public"."AutomationTokens" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."AutomationTokens" RENAME COLUMN "user_id" TO "UserId";
ALTER TABLE "public"."AutomationTokens" RENAME COLUMN "name" TO "Name";
ALTER TABLE "public"."AutomationTokens" RENAME COLUMN "token_hash" TO "TokenHash";
ALTER TABLE "public"."AutomationTokens" RENAME COLUMN "scopes" TO "Scopes";
ALTER TABLE "public"."AutomationTokens" RENAME COLUMN "created_at" TO "CreatedAt";
ALTER TABLE "public"."AutomationTokens" RENAME COLUMN "expires_at" TO "ExpiresAt";
ALTER TABLE "public"."AutomationTokens" RENAME COLUMN "last_used_at" TO "LastUsedAt";

ALTER TABLE "public"."DistTags" RENAME COLUMN "owner_id" TO "OwnerId";
ALTER TABLE "public"."DistTags" RENAME COLUMN "namespace" TO "Namespace";
ALTER TABLE "public"."DistTags" RENAME COLUMN "extension_id" TO "ExtensionId";
ALTER TABLE "public"."DistTags" RENAME COLUMN "tag" TO "Tag";
ALTER TABLE "public"."DistTags" RENAME COLUMN "version" TO "Version";
ALTER TABLE "public"."DistTags" RENAME COLUMN "created_at" TO "CreatedAt";

ALTER TABLE "public"."DownloadEvents" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."DownloadEvents" RENAME COLUMN "namespace" TO "Namespace";
ALTER TABLE "public"."DownloadEvents" RENAME COLUMN "extension_id" TO "ExtensionId";
ALTER TABLE "public"."DownloadEvents" RENAME COLUMN "version" TO "Version";
ALTER TABLE "public"."DownloadEvents" RENAME COLUMN "user_agent" TO "UserAgent";
ALTER TABLE "public"."DownloadEvents" RENAME COLUMN "ip_hash" TO "IpHash";
ALTER TABLE "public"."DownloadEvents" RENAME COLUMN "created_at" TO "CreatedAt";

ALTER TABLE "public"."ExtensionDailyDownloads" RENAME COLUMN "namespace" TO "Namespace";
ALTER TABLE "public"."ExtensionDailyDownloads" RENAME COLUMN "extension_id" TO "ExtensionId";
ALTER TABLE "public"."ExtensionDailyDownloads" RENAME COLUMN "day" TO "Day";
ALTER TABLE "public"."ExtensionDailyDownloads" RENAME COLUMN "total_downloads" TO "TotalDownloads";
ALTER TABLE "public"."ExtensionDailyDownloads" RENAME COLUMN "distinct_downloads" TO "DistinctDownloads";

ALTER TABLE "public"."ExtensionOwnerInvites" RENAME COLUMN "namespace" TO "Namespace";
ALTER TABLE "public"."ExtensionOwnerInvites" RENAME COLUMN "extension_id" TO "ExtensionId";
ALTER TABLE "public"."ExtensionOwnerInvites" RENAME COLUMN "owner_id" TO "OwnerId";
ALTER TABLE "public"."ExtensionOwnerInvites" RENAME COLUMN "invited_by" TO "InvitedBy";
ALTER TABLE "public"."ExtensionOwnerInvites" RENAME COLUMN "created_at" TO "CreatedAt";

ALTER TABLE "public"."ExtensionOwners" RENAME COLUMN "owner_id" TO "OwnerId";
ALTER TABLE "public"."ExtensionOwners" RENAME COLUMN "namespace" TO "Namespace";
ALTER TABLE "public"."ExtensionOwners" RENAME COLUMN "extension_id" TO "ExtensionId";
ALTER TABLE "public"."ExtensionOwners" RENAME COLUMN "added_by" TO "AddedBy";
ALTER TABLE "public"."ExtensionOwners" RENAME COLUMN "added_at" TO "AddedAt";

ALTER TABLE "public"."ExtensionRedirects" RENAME COLUMN "from_namespace" TO "FromNamespace";
ALTER TABLE "public"."ExtensionRedirects" RENAME COLUMN "from_extension_id" TO "FromExtensionId";
ALTER TABLE "public"."ExtensionRedirects" RENAME COLUMN "to_namespace" TO "ToNamespace";
ALTER TABLE "public"."ExtensionRedirects" RENAME COLUMN "to_extension_id" TO "ToExtensionId";
ALTER TABLE "public"."ExtensionRedirects" RENAME COLUMN "created_at" TO "CreatedAt";

ALTER TABLE "public"."ExtensionTransfers" RENAME COLUMN "namespace" TO "Namespace";
ALTER TABLE "public"."ExtensionTransfers" RENAME COLUMN "extension_id" TO "ExtensionId";
ALTER TABLE "public"."ExtensionTransfers" RENAME COLUMN "to_namespace" TO "ToNamespace";
ALTER TABLE "public"."ExtensionTransfers" RENAME COLUMN "requested_by" TO "RequestedBy";
ALTER TABLE "public"."ExtensionTransfers" RENAME COLUMN "created_at" TO "CreatedAt";

ALTER TABLE "public"."ExtensionVersionDailyDownloads" RENAME COLUMN "namespace" TO "Namespace";
ALTER TABLE "public"."ExtensionVersionDailyDownloads" RENAME COLUMN "extension_id" TO "ExtensionId";
ALTER TABLE "public"."ExtensionVersionDailyDownloads" RENAME COLUMN "version" TO "Version";
ALTER TABLE "public"."ExtensionVersionDailyDownloads" RENAME COLUMN "day" TO "Day";
ALTER TABLE "public"."ExtensionVersionDailyDownloads" RENAME COLUMN "total_downloads" TO "TotalDownloads";
ALTER TABLE "public"."ExtensionVersionDailyDownloads" RENAME COLUMN "distinct_downloads" TO "DistinctDownloads";

ALTER TABLE "public"."LegalDocuments" RENAME COLUMN "kind" TO "Kind";
ALTER TABLE "public"."LegalDocuments" RENAME COLUMN "version" TO "Version";
ALTER TABLE "public"."LegalDocuments" RENAME COLUMN "body" TO "Body";
ALTER TABLE "public"."LegalDocuments" RENAME COLUMN "updated_at" TO "UpdatedAt";

ALTER TABLE "public"."Notifications" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."Notifications" RENAME COLUMN "user_id" TO "UserId";
ALTER TABLE "public"."Notifications" RENAME COLUMN "kind" TO "Kind";
ALTER TABLE "public"."Notifications" RENAME COLUMN "message" TO "Message";
ALTER TABLE "public"."Notifications" RENAME COLUMN "payload" TO "Payload";
ALTER TABLE "public"."Notifications" RENAME COLUMN "read_at" TO "ReadAt";
ALTER TABLE "public"."Notifications" RENAME COLUMN "created_at" TO "CreatedAt";

ALTER TABLE "public"."OidcFlows" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."OidcFlows" RENAME COLUMN "kind" TO "Kind";
ALTER TABLE "public"."OidcFlows" RENAME COLUMN "state_hash" TO "StateHash";
ALTER TABLE "public"."OidcFlows" RENAME COLUMN "flow_secret_hash" TO "FlowSecretHash";
ALTER TABLE "public"."OidcFlows" RENAME COLUMN "code_verifier" TO "CodeVerifier";
ALTER TABLE "public"."OidcFlows" RENAME COLUMN "nonce" TO "Nonce";
ALTER TABLE "public"."OidcFlows" RENAME COLUMN "user_id" TO "UserId";
ALTER TABLE "public"."OidcFlows" RENAME COLUMN "return_to" TO "ReturnTo";
ALTER TABLE "public"."OidcFlows" RENAME COLUMN "exchange_code_hash" TO "ExchangeCodeHash";
ALTER TABLE "public"."OidcFlows" RENAME COLUMN "created_at" TO "CreatedAt";
ALTER TABLE "public"."OidcFlows" RENAME COLUMN "expires_at" TO "ExpiresAt";

ALTER TABLE "public"."OrganizationOwners" RENAME COLUMN "org_id" TO "OrgId";
ALTER TABLE "public"."OrganizationOwners" RENAME COLUMN "org_kind" TO "OrgKind";
ALTER TABLE "public"."OrganizationOwners" RENAME COLUMN "user_id" TO "UserId";
ALTER TABLE "public"."OrganizationOwners" RENAME COLUMN "user_kind" TO "UserKind";
ALTER TABLE "public"."OrganizationOwners" RENAME COLUMN "added_by" TO "AddedBy";
ALTER TABLE "public"."OrganizationOwners" RENAME COLUMN "added_at" TO "AddedAt";

ALTER TABLE "public"."RateLimitEntries" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."RateLimitEntries" RENAME COLUMN "bucket" TO "Bucket";
ALTER TABLE "public"."RateLimitEntries" RENAME COLUMN "window_start" TO "WindowStart";
ALTER TABLE "public"."RateLimitEntries" RENAME COLUMN "count" TO "Count";

ALTER TABLE "public"."Sessions" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."Sessions" RENAME COLUMN "user_id" TO "UserId";
ALTER TABLE "public"."Sessions" RENAME COLUMN "token_hash" TO "TokenHash";
ALTER TABLE "public"."Sessions" RENAME COLUMN "created_at" TO "CreatedAt";
ALTER TABLE "public"."Sessions" RENAME COLUMN "expires_at" TO "ExpiresAt";
ALTER TABLE "public"."Sessions" RENAME COLUMN "last_used_at" TO "LastUsedAt";

ALTER TABLE "public"."UserIdentities" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."UserIdentities" RENAME COLUMN "user_id" TO "UserId";
ALTER TABLE "public"."UserIdentities" RENAME COLUMN "issuer" TO "Issuer";
ALTER TABLE "public"."UserIdentities" RENAME COLUMN "subject" TO "Subject";
ALTER TABLE "public"."UserIdentities" RENAME COLUMN "email" TO "Email";
ALTER TABLE "public"."UserIdentities" RENAME COLUMN "created_at" TO "CreatedAt";

ALTER TABLE "public"."Users" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."Users" RENAME COLUMN "namespace" TO "Namespace";
ALTER TABLE "public"."Users" RENAME COLUMN "display_name" TO "DisplayName";
ALTER TABLE "public"."Users" RENAME COLUMN "password_hash" TO "PasswordHash";
ALTER TABLE "public"."Users" RENAME COLUMN "role" TO "Role";
ALTER TABLE "public"."Users" RENAME COLUMN "has_published" TO "HasPublished";
ALTER TABLE "public"."Users" RENAME COLUMN "terms_accepted_version" TO "TermsAcceptedVersion";
ALTER TABLE "public"."Users" RENAME COLUMN "created_at" TO "CreatedAt";
ALTER TABLE "public"."Users" RENAME COLUMN "bio" TO "Bio";
ALTER TABLE "public"."Users" RENAME COLUMN "website" TO "Website";
ALTER TABLE "public"."Users" RENAME COLUMN "github" TO "Github";
ALTER TABLE "public"."Users" RENAME COLUMN "avatar_url" TO "AvatarUrl";
ALTER TABLE "public"."Users" RENAME COLUMN "banner_url" TO "BannerUrl";
ALTER TABLE "public"."Users" RENAME COLUMN "blob_bytes" TO "BlobBytes";
ALTER TABLE "public"."Users" RENAME COLUMN "max_blob_bytes" TO "MaxBlobBytes";
ALTER TABLE "public"."Users" RENAME COLUMN "avatar_blob_digest" TO "AvatarBlobDigest";
ALTER TABLE "public"."Users" RENAME COLUMN "avatar_content_type" TO "AvatarContentType";
ALTER TABLE "public"."Users" RENAME COLUMN "avatar_bytes" TO "AvatarBytes";
ALTER TABLE "public"."Users" RENAME COLUMN "banner_blob_digest" TO "BannerBlobDigest";
ALTER TABLE "public"."Users" RENAME COLUMN "banner_content_type" TO "BannerContentType";
ALTER TABLE "public"."Users" RENAME COLUMN "banner_bytes" TO "BannerBytes";
ALTER TABLE "public"."Users" RENAME COLUMN "kind" TO "Kind";

ALTER TABLE "public"."Versions" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."Versions" RENAME COLUMN "owner_id" TO "OwnerId";
ALTER TABLE "public"."Versions" RENAME COLUMN "namespace" TO "Namespace";
ALTER TABLE "public"."Versions" RENAME COLUMN "extension_id" TO "ExtensionId";
ALTER TABLE "public"."Versions" RENAME COLUMN "version" TO "Version";
ALTER TABLE "public"."Versions" RENAME COLUMN "status" TO "Status";
ALTER TABLE "public"."Versions" RENAME COLUMN "name" TO "Name";
ALTER TABLE "public"."Versions" RENAME COLUMN "license" TO "License";
ALTER TABLE "public"."Versions" RENAME COLUMN "description" TO "Description";
ALTER TABLE "public"."Versions" RENAME COLUMN "author" TO "Author";
ALTER TABLE "public"."Versions" RENAME COLUMN "color1" TO "Color1";
ALTER TABLE "public"."Versions" RENAME COLUMN "color2" TO "Color2";
ALTER TABLE "public"."Versions" RENAME COLUMN "color3" TO "Color3";
ALTER TABLE "public"."Versions" RENAME COLUMN "blob_path" TO "BlobPath";
ALTER TABLE "public"."Versions" RENAME COLUMN "search_text" TO "SearchText";
ALTER TABLE "public"."Versions" RENAME COLUMN "created_at" TO "CreatedAt";
ALTER TABLE "public"."Versions" RENAME COLUMN "published_at" TO "PublishedAt";
ALTER TABLE "public"."Versions" RENAME COLUMN "rejection_reason" TO "RejectionReason";
ALTER TABLE "public"."Versions" RENAME COLUMN "blob_digest" TO "BlobDigest";
ALTER TABLE "public"."Versions" RENAME COLUMN "blob_size" TO "BlobSize";
ALTER TABLE "public"."Versions" RENAME COLUMN "blob_sha512" TO "BlobSha512";
ALTER TABLE "public"."Versions" RENAME COLUMN "deprecation_message" TO "DeprecationMessage";
ALTER TABLE "public"."Versions" RENAME COLUMN "source_path" TO "SourcePath";
ALTER TABLE "public"."Versions" RENAME COLUMN "source_digest" TO "SourceDigest";
ALTER TABLE "public"."Versions" RENAME COLUMN "source_size" TO "SourceSize";
ALTER TABLE "public"."Versions" RENAME COLUMN "build_log" TO "BuildLog";
ALTER TABLE "public"."Versions" RENAME COLUMN "build_error" TO "BuildError";
ALTER TABLE "public"."Versions" RENAME COLUMN "is_unsandboxed" TO "IsUnsandboxed";
ALTER TABLE "public"."Versions" RENAME COLUMN "warnings" TO "Warnings";

ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "webhook_id" TO "WebhookId";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "event" TO "Event";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "payload" TO "Payload";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "body" TO "Body";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "signature" TO "Signature";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "attempt" TO "Attempt";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "max_attempts" TO "MaxAttempts";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "status" TO "Status";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "next_attempt_at" TO "NextAttemptAt";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "last_error" TO "LastError";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "created_at" TO "CreatedAt";
ALTER TABLE "public"."WebhookDeliveries" RENAME COLUMN "updated_at" TO "UpdatedAt";

ALTER TABLE "public"."Webhooks" RENAME COLUMN "id" TO "Id";
ALTER TABLE "public"."Webhooks" RENAME COLUMN "namespace" TO "Namespace";
ALTER TABLE "public"."Webhooks" RENAME COLUMN "extension_id" TO "ExtensionId";
ALTER TABLE "public"."Webhooks" RENAME COLUMN "url" TO "Url";
ALTER TABLE "public"."Webhooks" RENAME COLUMN "secret" TO "Secret";
ALTER TABLE "public"."Webhooks" RENAME COLUMN "events" TO "Events";
ALTER TABLE "public"."Webhooks" RENAME COLUMN "active" TO "Active";
ALTER TABLE "public"."Webhooks" RENAME COLUMN "last_delivery_status" TO "LastDeliveryStatus";
ALTER TABLE "public"."Webhooks" RENAME COLUMN "last_delivery_at" TO "LastDeliveryAt";
ALTER TABLE "public"."Webhooks" RENAME COLUMN "created_at" TO "CreatedAt";

-- The retention triggers call functions whose bodies name the columns, and
-- Postgres does not rewrite a plpgsql body when a column is renamed. Replacing
-- the function keeps its OID, so the triggers keep pointing at it.
CREATE OR REPLACE FUNCTION prune_notifications() RETURNS trigger AS $$
  BEGIN
    -- Serialize per user so concurrent inserts cannot race the retention
    -- delete. Xact-scoped, so it releases on commit or rollback.
    PERFORM pg_advisory_xact_lock(NEW."UserId");
    DELETE FROM "public"."Notifications"
    WHERE "UserId" = NEW."UserId" AND "Id" <= (
      SELECT "Id" FROM "public"."Notifications"
      WHERE "UserId" = NEW."UserId"
      ORDER BY "Id" DESC
      OFFSET 200
      LIMIT 1
    );
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prune_webhook_deliveries() RETURNS trigger AS $$
  BEGIN
    DELETE FROM "public"."WebhookDeliveries"
    WHERE "WebhookId" = NEW."WebhookId" AND "Id" <= (
      SELECT "Id" FROM "public"."WebhookDeliveries"
      WHERE "WebhookId" = NEW."WebhookId"
      ORDER BY "Id" DESC
      OFFSET 500
      LIMIT 1
    );
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;
