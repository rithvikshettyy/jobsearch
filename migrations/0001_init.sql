-- job-bot schema. Applied with: npm run migrate (local) / npm run migrate:remote (prod)

CREATE TABLE IF NOT EXISTS companies (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('greenhouse', 'lever', 'ashby')),
  board  TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_companies_active ON companies (active, id);

-- Every external id ever observed. This is the phase-1 diff set: an id present
-- here never triggers a JD fetch again.
CREATE TABLE IF NOT EXISTS seen_postings (
  company_id  INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  external_id TEXT    NOT NULL,
  first_seen  TEXT    NOT NULL,
  PRIMARY KEY (company_id, external_id)
);

-- Jobs actually pushed to Telegram, keyed by the content hash so a repost under
-- a new external id does not notify twice.
CREATE TABLE IF NOT EXISTS jobs (
  dedupe_key  TEXT PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  external_id TEXT    NOT NULL,
  company     TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  location    TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  posted_at   TEXT,
  notified_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_notified_at ON jobs (notified_at DESC);

-- Cron triggers do not retry, so every catch lands here.
CREATE TABLE IF NOT EXISTS errors (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  company TEXT,
  stage   TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_errors_ts ON errors (ts DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('cursor', '0');
