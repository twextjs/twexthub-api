-- Download events keep a keyed hash of the client address rather than the
-- address itself: the daily aggregate only has to tell clients apart. An
-- unsalted hash of an IPv4 address is reversible in seconds, so the key is
-- generated on first use and lives on disk, outside the database (see
-- src/download-address.js).
ALTER TABLE download_events RENAME COLUMN remote_addr TO ip_hash;

-- Everything in the column predates the keyed hash, and nothing reads the
-- table for more than the daily rollup, which is all trending and download
-- totals use. The stored addresses are dropped rather than relabelled: a raw
-- address must not survive the migration under a name that claims to be a
-- hash. Rows still count as downloads; distinct counts for those days fall
-- back to the user agent.
UPDATE download_events SET ip_hash = NULL;
