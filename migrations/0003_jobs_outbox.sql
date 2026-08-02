-- `jobs` becomes an outbox: store.ts inserts a row BEFORE the Telegram send and
-- flips `notified` after, so a send that fails leaves a retryable row instead of
-- losing the job. That makes `notified_at` unknown at insert time, and SQLite
-- cannot drop a NOT NULL constraint in place — hence the rebuild.
--
-- `notified` also flips default 1 -> 0: a freshly inserted row is by definition
-- not yet sent. Existing rows were all written post-send, so they carry over as
-- notified = 1 with created_at backfilled from notified_at.

CREATE TABLE jobs_new (
  dedupe_key  TEXT    PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  external_id TEXT    NOT NULL,
  company     TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  location    TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  posted_at   TEXT,
  yoe_min     INTEGER,
  notified    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  notified_at TEXT
);

INSERT INTO jobs_new (
  dedupe_key, company_id, external_id, company, title, location, url,
  posted_at, yoe_min, notified, created_at, notified_at
)
SELECT
  dedupe_key, company_id, external_id, company, title, location, url,
  posted_at, yoe_min, notified, notified_at, notified_at
FROM jobs;

-- Drops the old indexes along with the table; both are recreated below.
DROP TABLE jobs;

ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX IF NOT EXISTS idx_jobs_notified ON jobs (notified);
CREATE INDEX IF NOT EXISTS idx_jobs_notified_at ON jobs (notified_at DESC);
