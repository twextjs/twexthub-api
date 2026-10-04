CREATE TABLE webhooks (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  url TEXT NOT NULL,
  -- Plaintext is required: the hub signs each delivery with this secret.
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  last_delivery_status TEXT,
  last_delivery_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX webhooks_extension_idx ON webhooks(namespace, extension_id);

CREATE TABLE webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  webhook_id BIGINT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  -- The exact bytes that were signed, since jsonb round-trips reorder keys.
  body TEXT NOT NULL,
  signature TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'pending',
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries(status, next_attempt_at)
  WHERE status IN ('pending', 'retrying');

-- Keep the newest 500 deliveries per webhook.
CREATE FUNCTION prune_webhook_deliveries() RETURNS trigger AS $$
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

CREATE TRIGGER webhook_deliveries_prune
  AFTER INSERT ON webhook_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION prune_webhook_deliveries();
