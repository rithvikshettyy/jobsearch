-- Part 0 fixes: per-run funnel counters, least-recently-polled sharding, and the
-- fuzzy dedupe key that merges the same role seen with different locations.
--
-- Additive only (ALTER ... ADD COLUMN, CREATE TABLE). `companies` is NOT rebuilt
-- here: a rebuild cascades into seen_postings/jobs, see the warning in 0004.

-- Sharding: poll the company that has waited longest, so adding, deactivating or
-- reordering boards never skips anyone the way an id offset could.
ALTER TABLE companies ADD COLUMN last_polled_at TEXT;
-- Consecutive failed polls. Reset to 0 by a good poll.
ALTER TABLE companies ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
-- Consecutive 404s from the board endpoint, for auto-disable (Part 4).
ALTER TABLE companies ADD COLUMN consec_404 INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_companies_polled ON companies (active, last_polled_at);

-- sha256(lower(company) | normalised title). NULL on rows written before this
-- migration, which only means they cannot absorb a later duplicate.
ALTER TABLE jobs ADD COLUMN fuzzy_key TEXT;
-- ";"-joined union of every location this job was seen with. `location` stays
-- the first one seen; notify prints `locations` when present.
ALTER TABLE jobs ADD COLUMN locations TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_fuzzy ON jobs (fuzzy_key, created_at);

-- One row per tick (kind = 'tick') plus one per company polled in it
-- (kind = 'company'), sharing a run_id. A tick row whose finished_at stays NULL
-- is a tick that died before finishing: that is how a CPU-limit kill shows up,
-- because Workers gives the code no chance to log it.
--
-- Funnel columns are cumulative survivors, in pipeline order:
--   fetched -> new_ids -> passed_title -> passed_location -> passed_fresh
--   -> detailed -> passed_description -> passed_yoe -> deduped -> queued
CREATE TABLE IF NOT EXISTS source_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT    NOT NULL,
  kind                TEXT    NOT NULL CHECK (kind IN ('tick', 'company')),
  started_at          TEXT    NOT NULL,
  finished_at         TEXT,
  company_id          INTEGER,
  company             TEXT,
  source              TEXT,
  fetched             INTEGER NOT NULL DEFAULT 0,
  new_ids             INTEGER NOT NULL DEFAULT 0,
  passed_title        INTEGER NOT NULL DEFAULT 0,
  passed_location     INTEGER NOT NULL DEFAULT 0,
  passed_fresh        INTEGER NOT NULL DEFAULT 0,
  detailed            INTEGER NOT NULL DEFAULT 0,
  passed_description  INTEGER NOT NULL DEFAULT 0,
  passed_yoe          INTEGER NOT NULL DEFAULT 0,
  unknown_yoe_blocked INTEGER NOT NULL DEFAULT 0,
  deduped             INTEGER NOT NULL DEFAULT 0,
  queued              INTEGER NOT NULL DEFAULT 0,
  sent                INTEGER NOT NULL DEFAULT 0,
  errors              INTEGER NOT NULL DEFAULT 0,
  subrequests         INTEGER NOT NULL DEFAULT 0,
  wall_ms             INTEGER,
  -- 'subrequest_limit' | 'timeout' | 'http' | 'other'. NULL = no error.
  error_kind          TEXT,
  error               TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_runs_started ON source_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_runs_run ON source_runs (run_id);
CREATE INDEX IF NOT EXISTS idx_source_runs_company ON source_runs (company_id, started_at DESC);
