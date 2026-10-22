-- Static-analysis warnings about the uploaded source, so review can flag
-- risky patterns without rerunning the build. Each entry is
-- { code, file, line, message }; an empty array means the scan found nothing.
ALTER TABLE versions
  ADD COLUMN warnings JSONB NOT NULL DEFAULT '[]'::jsonb;
