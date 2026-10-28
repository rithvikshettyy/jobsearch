-- Part 2: `jobs` becomes the approval queue as well as the outbox.
--
-- Additive only (ALTER ... ADD COLUMN). `jobs` is NOT rebuilt: that would also
-- renumber rowid, and the queue uses rowid as the job id in Telegram buttons.

-- new | approved | skipped | applying | applied | failed | manual
ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
-- Where it was found: a company source id ('greenhouse', 'himalayas') or an
-- ingest source ('x', 'jobspy'). `sources` is the comma-joined list of every
-- source that has reported it, first one first.
ALTER TABLE jobs ADD COLUMN source TEXT;
ALTER TABLE jobs ADD COLUMN sources TEXT;
-- Normalised URL: https, no www, no tracking params, no fragment, no trailing
-- slash. The global dedupe key across every source.
ALTER TABLE jobs ADD COLUMN url_norm TEXT;
ALTER TABLE jobs ADD COLUMN tweet_url TEXT;
ALTER TABLE jobs ADD COLUMN fail_reason TEXT;
ALTER TABLE jobs ADD COLUMN updated_at TEXT;

-- Everything already here was sent before there was a queue. It is history, not
-- work: marking it skipped keeps it out of /queue and off the buttons.
UPDATE jobs SET status = 'skipped', updated_at = COALESCE(notified_at, created_at);

-- Best-effort backfill for rows whose URL has no query or fragment, so a job the
-- bot already sent is not announced again when another source finds it. Only the
-- lowest rowid of each group gets a value: the unique index below would
-- otherwise reject the migration on two old rows that share a URL.
UPDATE jobs
   SET url_norm = rtrim(replace(replace(lower(url), 'http://', 'https://'), '://www.', '://'), '/')
 WHERE instr(url, '?') = 0
   AND instr(url, '#') = 0
   AND rowid IN (
     SELECT min(rowid) FROM jobs
      WHERE instr(url, '?') = 0 AND instr(url, '#') = 0
      GROUP BY rtrim(replace(replace(lower(url), 'http://', 'https://'), '://www.', '://'), '/')
   );

-- NULLs are distinct in a SQLite unique index, so unbackfilled rows are fine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_url_norm ON jobs (url_norm);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, updated_at);

-- Rows from /ingest have no board behind them but `jobs.company_id` is NOT NULL
-- with a foreign key. This inactive row stands in for them. It is never polled
-- (active = 0) and its source id is not a poll source.
INSERT OR IGNORE INTO companies (name, source, board, active, tier) VALUES ('Ingest', 'ingest', '', 0, 2);
