-- An organization hook watches every extension in its namespace, so
-- extension_id has to be able to say "not one extension". A hook with NULL
-- there is a namespace-wide hook; the per-extension hook is unchanged and
-- keeps its own value.
--
-- Deliveries are unchanged: a delivery is still about one concrete extension,
-- named in its payload, even when it came from a namespace-wide hook.
ALTER TABLE webhooks ALTER COLUMN extension_id DROP NOT NULL;

-- The delivery scheduler looks hooks up by namespace and event on every
-- publish, so the lookup has to find both scopes from that pair alone.
DROP INDEX IF EXISTS webhooks_extension_idx;
CREATE INDEX webhooks_namespace_idx ON webhooks(namespace) WHERE active;
CREATE INDEX webhooks_extension_idx ON webhooks(namespace, extension_id);
