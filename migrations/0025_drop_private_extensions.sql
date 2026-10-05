-- Private extensions are gone. TurboWarp asks for an extension by URL, so a
-- private one could only be loaded by putting its credentials in that URL, and
-- there is no way to authenticate a request it does not sign. The grants and
-- the visibility column they keyed off go with the feature.
--
-- Dropping the column takes versions_visibility_idx with it.
LOCK TABLE versions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM versions WHERE visibility = 'private') THEN
    RAISE EXCEPTION 'private versions exist; resolve them before dropping visibility';
  END IF;
END $$;

DROP TABLE extension_access;

ALTER TABLE versions DROP COLUMN visibility;
