ALTER TABLE users
  ADD COLUMN bio TEXT NOT NULL DEFAULT '',
  ADD COLUMN website TEXT,
  ADD COLUMN github TEXT,
  ADD COLUMN avatar_url TEXT,
  ADD COLUMN banner_url TEXT;
