-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- EnableExtension
-- Before the trigram index below, which needs its operator class.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateTable
CREATE TABLE "public"."audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" BIGINT,
    "actor_namespace" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_namespace" TEXT,
    "target_extension_id" TEXT,
    "target_version" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."automation_tokens" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "automation_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."dist_tags" (
    "owner_id" BIGINT NOT NULL,
    "namespace" TEXT NOT NULL,
    "extension_id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "public"."download_events" (
    "id" BIGSERIAL NOT NULL,
    "namespace" TEXT NOT NULL,
    "extension_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL DEFAULT '',
    "ip_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "download_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."extension_daily_downloads" (
    "namespace" TEXT NOT NULL,
    "extension_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "total_downloads" BIGINT NOT NULL DEFAULT 0,
    "distinct_downloads" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "extension_daily_downloads_pkey" PRIMARY KEY ("namespace","extension_id","day")
);

-- CreateTable
CREATE TABLE "public"."extension_owner_invites" (
    "namespace" TEXT NOT NULL,
    "extension_id" TEXT NOT NULL,
    "owner_id" BIGINT NOT NULL,
    "invited_by" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_owner_invites_pkey" PRIMARY KEY ("namespace","extension_id","owner_id")
);

-- CreateTable
CREATE TABLE "public"."extension_owners" (
    "owner_id" BIGINT NOT NULL,
    "namespace" TEXT NOT NULL,
    "extension_id" TEXT NOT NULL,
    "added_by" BIGINT,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_owners_pkey" PRIMARY KEY ("namespace","extension_id","owner_id")
);

-- CreateTable
CREATE TABLE "public"."extension_redirects" (
    "from_namespace" TEXT NOT NULL,
    "from_extension_id" TEXT NOT NULL,
    "to_namespace" TEXT NOT NULL,
    "to_extension_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_redirects_pkey" PRIMARY KEY ("from_namespace","from_extension_id")
);

-- CreateTable
CREATE TABLE "public"."extension_transfers" (
    "namespace" TEXT NOT NULL,
    "extension_id" TEXT NOT NULL,
    "to_namespace" TEXT NOT NULL,
    "requested_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_transfers_pkey" PRIMARY KEY ("namespace","extension_id","to_namespace")
);

-- CreateTable
CREATE TABLE "public"."extension_version_daily_downloads" (
    "namespace" TEXT NOT NULL,
    "extension_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "total_downloads" BIGINT NOT NULL DEFAULT 0,
    "distinct_downloads" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "extension_version_daily_downloads_pkey" PRIMARY KEY ("namespace","extension_id","version","day")
);

-- CreateTable
CREATE TABLE "public"."legal_documents" (
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "body" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("kind")
);

-- CreateTable
CREATE TABLE "public"."notifications" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."oidc_flows" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "flow_secret_hash" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "user_id" BIGINT,
    "return_to" TEXT,
    "exchange_code_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "oidc_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."organization_owners" (
    "org_id" BIGINT NOT NULL,
    "org_kind" TEXT NOT NULL DEFAULT 'organization',
    "user_id" BIGINT NOT NULL,
    "user_kind" TEXT NOT NULL DEFAULT 'user',
    "added_by" BIGINT,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_owners_pkey" PRIMARY KEY ("org_id","user_id")
);

-- CreateTable
CREATE TABLE "public"."rate_limit_entries" (
    "id" BIGSERIAL NOT NULL,
    "bucket" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "rate_limit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sessions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_identities" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."users" (
    "id" BIGSERIAL NOT NULL,
    "namespace" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'normal',
    "has_published" BOOLEAN NOT NULL DEFAULT false,
    "terms_accepted_version" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bio" TEXT NOT NULL DEFAULT '',
    "website" TEXT,
    "github" TEXT,
    "avatar_url" TEXT,
    "banner_url" TEXT,
    "blob_bytes" BIGINT NOT NULL DEFAULT 0,
    "max_blob_bytes" BIGINT,
    "avatar_blob_digest" TEXT,
    "avatar_content_type" TEXT,
    "avatar_bytes" INTEGER,
    "banner_blob_digest" TEXT,
    "banner_content_type" TEXT,
    "banner_bytes" INTEGER,
    "kind" TEXT NOT NULL DEFAULT 'user',

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."versions" (
    "id" BIGSERIAL NOT NULL,
    "owner_id" BIGINT NOT NULL,
    "namespace" TEXT NOT NULL,
    "extension_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'staging',
    "name" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "author" TEXT,
    "color1" TEXT,
    "color2" TEXT,
    "color3" TEXT,
    "blob_path" TEXT NOT NULL,
    "search_text" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "blob_digest" TEXT,
    "blob_size" BIGINT,
    "blob_sha512" TEXT,
    "deprecation_message" TEXT,
    "source_path" TEXT,
    "source_digest" TEXT,
    "source_size" BIGINT NOT NULL DEFAULT 0,
    "build_log" TEXT,
    "build_error" TEXT,
    "is_unsandboxed" BOOLEAN,
    "warnings" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."webhook_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "webhook_id" BIGINT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "body" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 4,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."webhooks" (
    "id" BIGSERIAL NOT NULL,
    "namespace" TEXT NOT NULL,
    "extension_id" TEXT,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_delivery_status" TEXT,
    "last_delivery_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_created_idx" ON "public"."audit_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_target_idx" ON "public"."audit_log"("target_namespace" ASC, "target_extension_id" ASC) WHERE (target_namespace IS NOT NULL);

-- CreateIndex
ALTER TABLE "public"."automation_tokens" ADD CONSTRAINT "automation_tokens_token_hash_key" UNIQUE ("token_hash");

-- CreateIndex
CREATE INDEX "automation_tokens_user_id_idx" ON "public"."automation_tokens"("user_id" ASC);

-- CreateIndex
ALTER TABLE "public"."dist_tags" ADD CONSTRAINT "dist_tags_namespace_extension_id_tag_key" UNIQUE ("namespace", "extension_id", "tag");

-- CreateIndex
CREATE INDEX "dist_tags_namespace_id_idx" ON "public"."dist_tags"("namespace" ASC, "extension_id" ASC);

-- CreateIndex
CREATE INDEX "dist_tags_version_idx" ON "public"."dist_tags"("namespace" ASC, "extension_id" ASC, "version" ASC);

-- CreateIndex
CREATE INDEX "download_events_ns_id_ts_idx" ON "public"."download_events"("namespace" ASC, "extension_id" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "download_events_version_idx" ON "public"."download_events"("namespace" ASC, "extension_id" ASC, "version" ASC);

-- CreateIndex
CREATE INDEX "extension_owner_invites_owner_idx" ON "public"."extension_owner_invites"("owner_id" ASC);

-- CreateIndex
CREATE INDEX "extension_owners_owner_idx" ON "public"."extension_owners"("owner_id" ASC);

-- CreateIndex
CREATE INDEX "extension_redirects_to_idx" ON "public"."extension_redirects"("to_namespace" ASC, "to_extension_id" ASC);

-- CreateIndex
CREATE INDEX "extension_transfers_to_idx" ON "public"."extension_transfers"("to_namespace" ASC);

-- CreateIndex
CREATE INDEX "notifications_unread_idx" ON "public"."notifications"("user_id" ASC) WHERE (read_at IS NULL);

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "public"."notifications"("user_id" ASC, "id" DESC);

-- CreateIndex
ALTER TABLE "public"."oidc_flows" ADD CONSTRAINT "oidc_flows_exchange_code_hash_key" UNIQUE ("exchange_code_hash");

-- CreateIndex
CREATE INDEX "oidc_flows_expires_at_idx" ON "public"."oidc_flows"("expires_at" ASC);

-- CreateIndex
ALTER TABLE "public"."oidc_flows" ADD CONSTRAINT "oidc_flows_state_hash_key" UNIQUE ("state_hash");

-- CreateIndex
CREATE INDEX "organization_owners_user_idx" ON "public"."organization_owners"("user_id" ASC);

-- CreateIndex
ALTER TABLE "public"."rate_limit_entries" ADD CONSTRAINT "rate_limit_entries_bucket_window_start_key" UNIQUE ("bucket", "window_start");

-- CreateIndex
CREATE INDEX "rate_limit_entries_window_start_idx" ON "public"."rate_limit_entries"("window_start" ASC);

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "public"."sessions"("expires_at" ASC);

-- CreateIndex
ALTER TABLE "public"."sessions" ADD CONSTRAINT "sessions_token_hash_key" UNIQUE ("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "public"."sessions"("user_id" ASC);

-- CreateIndex
ALTER TABLE "public"."user_identities" ADD CONSTRAINT "user_identities_issuer_subject_key" UNIQUE ("issuer", "subject");

-- CreateIndex
CREATE INDEX "user_identities_user_id_idx" ON "public"."user_identities"("user_id" ASC);

-- CreateIndex
CREATE INDEX "users_avatar_blob_idx" ON "public"."users"("avatar_blob_digest" ASC) WHERE (avatar_blob_digest IS NOT NULL);

-- CreateIndex
CREATE INDEX "users_banner_blob_idx" ON "public"."users"("banner_blob_digest" ASC) WHERE (banner_blob_digest IS NOT NULL);

-- CreateIndex
ALTER TABLE "public"."users" ADD CONSTRAINT "users_id_kind_key" UNIQUE ("id", "kind");

-- CreateIndex
ALTER TABLE "public"."users" ADD CONSTRAINT "users_namespace_key" UNIQUE ("namespace");

-- CreateIndex
CREATE INDEX "versions_blob_digest_idx" ON "public"."versions"("blob_digest" ASC);

-- CreateIndex
CREATE INDEX "versions_namespace_id_idx" ON "public"."versions"("namespace" ASC, "extension_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "versions_one_pending_idx" ON "public"."versions"("owner_id" ASC) WHERE (status = ANY (ARRAY['staging'::text, 'pending'::text]));

-- CreateIndex
ALTER TABLE "public"."versions" ADD CONSTRAINT "versions_owner_id_extension_id_version_key" UNIQUE ("owner_id", "extension_id", "version");

-- CreateIndex
CREATE INDEX "versions_public_listing_idx" ON "public"."versions"("namespace" ASC, "extension_id" ASC, "status" ASC, "published_at" DESC) WHERE (status = ANY (ARRAY['published'::text, 'deprecated'::text]));

-- CreateIndex
-- The `ASC` Prisma's SQL writer appends here is not accepted by the GIN access
-- method, so it is dropped: `migrate diff` regenerating this line would put it
-- back and the baseline would stop applying to an empty database.
CREATE INDEX "versions_search_text_trgm_idx" ON "public"."versions" USING GIN ("search_text" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "versions_source_digest_idx" ON "public"."versions"("source_digest" ASC) WHERE (source_digest IS NOT NULL);

-- CreateIndex
CREATE INDEX "versions_status_created_at_idx" ON "public"."versions"("status" ASC, "created_at" ASC);

-- CreateIndex
CREATE INDEX "versions_status_published_at_idx" ON "public"."versions"("status" ASC, "published_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_due_idx" ON "public"."webhook_deliveries"("status" ASC, "next_attempt_at" ASC) WHERE (status = ANY (ARRAY['pending'::text, 'retrying'::text, 'delivering'::text]));

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "public"."webhook_deliveries"("webhook_id" ASC, "id" DESC);

-- CreateIndex
CREATE INDEX "webhooks_extension_idx" ON "public"."webhooks"("namespace" ASC, "extension_id" ASC);

-- CreateIndex
CREATE INDEX "webhooks_namespace_idx" ON "public"."webhooks"("namespace" ASC) WHERE active;

-- AddForeignKey
ALTER TABLE "public"."audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."automation_tokens" ADD CONSTRAINT "automation_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."dist_tags" ADD CONSTRAINT "dist_tags_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."extension_owner_invites" ADD CONSTRAINT "extension_owner_invites_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "public"."extension_owner_invites" ADD CONSTRAINT "extension_owner_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."extension_owners" ADD CONSTRAINT "extension_owners_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- The cascade is declared first because 0010_extension_owners.sql wrote its two
-- references in that order, and the order decides whether an account can be
-- deleted: Postgres checks referencing rows in the order the constraints were
-- created, so a no-action reference created before the cascade sees the row the
-- cascade is about to remove. Swap these two lines and deleting a publisher
-- fails on the owner row it added for itself.
ALTER TABLE "public"."extension_owners" ADD CONSTRAINT "extension_owners_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."extension_transfers" ADD CONSTRAINT "extension_transfers_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."oidc_flows" ADD CONSTRAINT "oidc_flows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."organization_owners" ADD CONSTRAINT "organization_owners_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."organization_owners" ADD CONSTRAINT "organization_owners_org_id_org_kind_fkey" FOREIGN KEY ("org_id", "org_kind") REFERENCES "public"."users"("id", "kind") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."organization_owners" ADD CONSTRAINT "organization_owners_user_id_user_kind_fkey" FOREIGN KEY ("user_id", "user_kind") REFERENCES "public"."users"("id", "kind") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."versions" ADD CONSTRAINT "versions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- prune_notifications function
CREATE OR REPLACE FUNCTION prune_notifications() RETURNS trigger AS $$
  BEGIN
    -- Serialize per user so concurrent inserts cannot race the retention
    -- delete. Xact-scoped, so it releases on commit or rollback.
    PERFORM pg_advisory_xact_lock(NEW.user_id);
    DELETE FROM notifications
    WHERE user_id = NEW.user_id AND id <= (
      SELECT id FROM notifications
      WHERE user_id = NEW.user_id
      ORDER BY id DESC
      OFFSET 200
      LIMIT 1
    );
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prune_webhook_deliveries() RETURNS trigger AS $$
  BEGIN
    DELETE FROM webhook_deliveries
    WHERE webhook_id = NEW.webhook_id AND id <= (
      SELECT id FROM webhook_deliveries
      WHERE webhook_id = NEW.webhook_id
      ORDER BY id DESC
      OFFSET 500
      LIMIT 1
    );
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

-- The named CHECK constraints the SQL migrations carried. Prisma has no way to
-- model a CHECK constraint, so they live here rather than in
-- prisma/schema.prisma; `migrate diff` will not reproduce them.
ALTER TABLE "public"."legal_documents" ADD CONSTRAINT "legal_documents_kind_check" CHECK (kind IN ('terms', 'privacy'));
ALTER TABLE "public"."notifications" ADD CONSTRAINT "notifications_kind_check" CHECK (kind IN ('review.approved', 'review.rejected', 'terms.bumped', 'tokens.revoked', 'role.changed', 'broadcast', 'extension.owner.added', 'extension.owner.removed', 'extension.owner.invited', 'extension.owner.withdrawn', 'extension.transfer.requested', 'extension.transfer.completed', 'organization.owner.added', 'organization.owner.removed'));
ALTER TABLE "public"."oidc_flows" ADD CONSTRAINT "oidc_flows_kind_check" CHECK (kind IN ('signin', 'link'));
ALTER TABLE "public"."organization_owners" ADD CONSTRAINT "organization_owners_org_kind_check" CHECK (org_kind = 'organization');
ALTER TABLE "public"."organization_owners" ADD CONSTRAINT "organization_owners_user_kind_check" CHECK (user_kind = 'user');
ALTER TABLE "public"."users" ADD CONSTRAINT "users_kind_check" CHECK (kind IN ('user', 'organization'));
ALTER TABLE "public"."users" ADD CONSTRAINT "users_password_matches_kind" CHECK (kind = 'user' OR (kind = 'organization' AND password_hash IS NULL));
ALTER TABLE "public"."users" ADD CONSTRAINT "users_role_check" CHECK (role IN ('admin', 'normal'));
ALTER TABLE "public"."versions" ADD CONSTRAINT "versions_status_check" CHECK (status IN ('staging', 'pending', 'published', 'rejected', 'yanked', 'deprecated'));

-- triggers
CREATE TRIGGER notifications_prune AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION prune_notifications();
CREATE TRIGGER webhook_deliveries_prune AFTER INSERT ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION prune_webhook_deliveries();
