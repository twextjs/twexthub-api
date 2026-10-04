-- Uploaded profile images live in the shared blob store keyed by digest, so a
-- users row records the digest plus the metadata needed to serve it back. The
-- image is not rewritten into avatar_url/banner_url by the upload itself: the
-- routes set the *_blob_digest columns and serialization reports the canonical
-- /users/{namespace}/{image} path, which keeps one stable URL whether the bytes
-- came from an upload or from an external reference.
ALTER TABLE users
  ADD COLUMN avatar_blob_digest TEXT,
  ADD COLUMN avatar_content_type TEXT,
  ADD COLUMN avatar_bytes INTEGER,
  ADD COLUMN banner_blob_digest TEXT,
  ADD COLUMN banner_content_type TEXT,
  ADD COLUMN banner_bytes INTEGER;

-- The blob collector and the verifier both walk the referenced set, so the
-- digests a user points at have to be indexed alongside the version blobs.
CREATE INDEX users_avatar_blob_idx ON users (avatar_blob_digest)
  WHERE avatar_blob_digest IS NOT NULL;
CREATE INDEX users_banner_blob_idx ON users (banner_blob_digest)
  WHERE banner_blob_digest IS NOT NULL;
