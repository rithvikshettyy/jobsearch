-- Adds 'adzuna' and 'jsearch' to the `companies.source` CHECK.
--
-- WHY THESE TWO AND NOT THE SITES THEMSELVES: Indeed, ZipRecruiter, Glassdoor,
-- Monster, SimplyHired, Naukri, Snagajob, Jora, WorkIndia, Hirect and Jobcase
-- were all probed directly. None is pollable from a Worker:
--
--   Indeed        RSS 404, search 403 (Publisher API closed 2023)
--   Glassdoor     HTML only (API deprecated 2021)
--   ZipRecruiter  502 on the public path; partner API needs approval
--   Naukri        internal jobapi/v3 answers 406 "recaptcha required"
--   Monster IN    internal middleware, 400 content-negotiation
--   Snagajob      403 Cloudflare bot challenge
--   SimplyHired / Jora / WorkIndia / Hirect / Jobcase   no feed at all
--
-- Even where HTML is reachable it is 260KB-870KB per page, which cannot be
-- parsed inside the free plan's 10ms CPU budget (see CLAUDE.md). Adzuna and
-- JSearch license the same inventory and return small JSON, so they are the
-- supported route to those listings.

-- SQLite cannot alter a CHECK in place, so `companies` is rebuilt. Migration
-- 0004 did this too and cascaded: seen_postings and jobs both declare
--   REFERENCES companies (id) ON DELETE CASCADE
-- and the cascade fires on the DROP itself, taking ~1200 rows with it. Copying
-- the children out to FK-free tables first is what stops that happening again.
CREATE TABLE seen_postings_backup AS SELECT * FROM seen_postings;
CREATE TABLE jobs_backup AS SELECT * FROM jobs;

CREATE TABLE companies_new (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('greenhouse', 'lever', 'ashby', 'remotive', 'remoteok', 'adzuna', 'jsearch')),
  board  TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  tier   INTEGER NOT NULL DEFAULT 2
);

INSERT INTO companies_new (id, name, source, board, active, tier)
SELECT id, name, source, board, active, tier FROM companies;

DROP TABLE companies;

ALTER TABLE companies_new RENAME TO companies;

CREATE INDEX IF NOT EXISTS idx_companies_active ON companies (active, id);

-- Children restored against the preserved ids. OR IGNORE because the cascade
-- leaves the tables empty on a live database but a no-op on a fresh one, where
-- these inserts would otherwise collide with nothing at all.
INSERT OR IGNORE INTO seen_postings (company_id, external_id, first_seen)
SELECT company_id, external_id, first_seen FROM seen_postings_backup;

INSERT OR IGNORE INTO jobs (
  dedupe_key, company_id, external_id, company, title, location, url,
  posted_at, yoe_min, notified, created_at, notified_at
)
SELECT
  dedupe_key, company_id, external_id, company, title, location, url,
  posted_at, yoe_min, notified, created_at, notified_at
FROM jobs_backup;

DROP TABLE seen_postings_backup;
DROP TABLE jobs_backup;

-- Feed rows. `board` is a selector, not an employer slug:
--   adzuna   country:what:where          (country is an Adzuna market code)
--   jsearch  query|country|date_posted
INSERT INTO companies (name, source, board, active, tier) VALUES
  ('Adzuna IN - software engineer', 'adzuna',  'in:software engineer:',  1, 2),
  ('Adzuna IN - python developer',  'adzuna',  'in:python developer:',   1, 2),
  ('Adzuna IN - frontend',          'adzuna',  'in:frontend developer:', 1, 2),
  -- INACTIVE ON PURPOSE. JSearch's free RapidAPI tier is 200 requests/MONTH.
  -- The cron is */2 and getShard rotates 8 companies per tick, so an active row
  -- here burns the whole monthly quota in under a day. Before setting active=1:
  --   1. move "crons" in wrangler.jsonc to hourly or slower, and
  --   2. npx wrangler secret put RAPIDAPI_KEY
  -- Then: UPDATE companies SET active = 1 WHERE source = 'jsearch';
  ('JSearch IN - software engineer', 'jsearch', 'software engineer in India|in|week', 0, 2)
ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board;
