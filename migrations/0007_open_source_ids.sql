-- Drops the `companies.source` CHECK and adds role-search sources ('himalayas').
--
-- The CHECK made every new source cost a table rebuild. Source ids are validated
-- in code (`isSourceId` in src/sources/index.ts), so the constraint goes and the
-- next source needs no migration.
--
-- Rebuilding `companies` cascades: seen_postings and jobs both declare
--   REFERENCES companies (id) ON DELETE CASCADE
-- and the cascade fires on the DROP itself (this is what 0004 did to ~1200 rows).
-- The children are copied to FK-free tables first, as in 0005, and restored with
-- every column that 0006 added.
CREATE TABLE seen_postings_backup AS SELECT * FROM seen_postings;
CREATE TABLE jobs_backup AS SELECT * FROM jobs;

CREATE TABLE companies_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  source         TEXT NOT NULL,
  board          TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  tier           INTEGER NOT NULL DEFAULT 2,
  last_polled_at TEXT,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  consec_404     INTEGER NOT NULL DEFAULT 0
);

INSERT INTO companies_new (id, name, source, board, active, tier, last_polled_at, fail_count, consec_404)
SELECT id, name, source, board, active, tier, last_polled_at, fail_count, consec_404 FROM companies;

DROP TABLE companies;

ALTER TABLE companies_new RENAME TO companies;

CREATE INDEX IF NOT EXISTS idx_companies_active ON companies (active, id);
CREATE INDEX IF NOT EXISTS idx_companies_polled ON companies (active, last_polled_at);

-- OR IGNORE: on a live database the cascade empties both tables, on a fresh one
-- these inserts have nothing to collide with.
INSERT OR IGNORE INTO seen_postings (company_id, external_id, first_seen)
SELECT company_id, external_id, first_seen FROM seen_postings_backup;

INSERT OR IGNORE INTO jobs (
  dedupe_key, company_id, external_id, company, title, location, url,
  posted_at, yoe_min, notified, created_at, notified_at, fuzzy_key, locations
)
SELECT
  dedupe_key, company_id, external_id, company, title, location, url,
  posted_at, yoe_min, notified, created_at, notified_at, fuzzy_key, locations
FROM jobs_backup;

DROP TABLE seen_postings_backup;
DROP TABLE jobs_backup;
