-- `companies.source` carried a CHECK limited to the three ATSs, so inserting a
-- feed row failed outright. SQLite cannot alter a CHECK constraint in place —
-- hence the rebuild, same pattern as 0003.
--
-- Aggregator feeds are modelled as companies whose `board` is a feed selector
-- rather than an employer slug ("all", or a Remotive category).

CREATE TABLE companies_new (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('greenhouse', 'lever', 'ashby', 'remotive', 'remoteok')),
  board  TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  tier   INTEGER NOT NULL DEFAULT 2
);

INSERT INTO companies_new (id, name, source, board, active, tier)
SELECT id, name, source, board, active, tier FROM companies;

-- WARNING, learned the hard way: seen_postings and jobs both declare
--   REFERENCES companies (id) ON DELETE CASCADE
-- so this DROP cascaded and took ~1200 seen_postings rows and 4 jobs rows with
-- it on the already-populated database. Preserving the ids above was not
-- enough — the cascade fires on the drop itself, before the rename.
--
-- Harmless on a fresh database (both tables are empty at this point), which is
-- why this file is left as applied. Any FUTURE rebuild of `companies` must
-- either copy the child tables out and back, or run with foreign keys disabled.
DROP TABLE companies;

ALTER TABLE companies_new RENAME TO companies;

CREATE INDEX IF NOT EXISTS idx_companies_active ON companies (active, id);

INSERT INTO companies (name, source, board, active, tier) VALUES
  ('Remotive', 'remotive', 'software-dev', 1, 2),
  ('Remote OK', 'remoteok', 'all', 1, 2)
ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
