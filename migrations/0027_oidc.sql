-- Accounts created by an identity provider have no password of their own, so
-- the constraint now only says what remains true of both kinds: an
-- organization never has a password.
ALTER TABLE users DROP CONSTRAINT users_password_matches_kind;
ALTER TABLE users ADD CONSTRAINT users_password_matches_kind CHECK (
  kind = 'user' OR (kind = 'organization' AND password_hash IS NULL)
);

-- An external identity: which account the provider says this is, keyed on the
-- pair that never changes there. Email is kept for the operator's reference
-- only -- accounts are never matched or linked by it.
CREATE TABLE user_identities (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE INDEX user_identities_user_id_idx ON user_identities(user_id);

-- A sign-in or link attempt in flight. One row carries everything the callback
-- has to prove with: the state it handed the provider, the PKCE verifier to
-- redeem the code, and the nonce to match in the ID token. A finished sign-in
-- keeps its row for the one-time exchange code the browser is sent, so the
-- session token itself is never carried in a URL.
CREATE TABLE oidc_flows (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('signin', 'link')),
  state_hash TEXT NOT NULL UNIQUE,
  -- The hash of a secret set as a cookie in the browser that began the flow,
  -- so a callback from a different browser cannot complete it: state alone
  -- stops a forged callback, not a valid one replayed into another browser.
  flow_secret_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  return_to TEXT,
  exchange_code_hash TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX oidc_flows_expires_at_idx ON oidc_flows(expires_at);
