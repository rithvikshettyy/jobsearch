-- Adds company tiering, parsed experience floor, and an explicit notified flag.
-- ALTER TABLE ... ADD COLUMN is not idempotent in SQLite (no IF NOT EXISTS), but
-- D1 applies each migration file exactly once, so this runs only on first apply.

-- Priority band for the poll rotation. 1 = highest. Existing rows land mid-band.
ALTER TABLE companies ADD COLUMN tier INTEGER NOT NULL DEFAULT 2;

-- Minimum years of experience parsed out of the JD. NULL = not stated / unparsed.
ALTER TABLE jobs ADD COLUMN yoe_min INTEGER;

-- 1 = pushed to Telegram. Every pre-existing row was written only after a
-- successful send, so backfilling them to 1 is correct.
ALTER TABLE jobs ADD COLUMN notified INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_jobs_notified ON jobs (notified);
