import { AUTO_DISABLE_404S } from './config';
import { isSourceId } from './sources';
import { normalizeUrl } from './url';
import type { Company, Env, Job, JobDetail } from './types';

/**
 * Bound parameters per statement. D1 caps this well below SQLite's own limit, so
 * anything driven by a caller-supplied array is chunked to this width and the
 * chunks go out as one `env.DB.batch()` round trip.
 */
const PARAM_CHUNK = 50;

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
	return out;
}

/** A job persisted before its send. `hash` is the sha256 dedupe key. */
export interface PendingJob {
	hash: string;
	/** sha256(lower(company) | normalised title), the cross-location dedupe key. */
	fuzzy: string;
	companyId: number;
	job: JobDetail;
	/** Source id that found it: a company source ('greenhouse') or an ingest source ('x'). */
	source: string;
	/** The tweet a job was lifted from, for X-sourced rows. */
	tweetUrl?: string | null;
}

/** An outbox row waiting to be pushed. */
export interface UnnotifiedJob {
	/** `jobs.rowid`, the id carried in the Apply and Skip buttons. */
	id: number;
	hash: string;
	sources: string | null;
	tweetUrl: string | null;
	job: Job;
	/** Drives the notify prefix. Null = the JD never named a number. */
	yoeMin: number | null;
}

interface CompanyRow {
	id: number;
	name: string;
	source: string;
	board: string;
	tier: number;
}

interface JobRow {
	id: number;
	sources: string | null;
	tweet_url: string | null;
	dedupe_key: string;
	external_id: string;
	company: string;
	title: string;
	location: string;
	url: string;
	posted_at: string | null;
	yoe_min: number | null;
	locations: string | null;
}

/**
 * The `size` active companies that have waited longest since their last poll,
 * stamped as polled.
 *
 * Least-recently-polled-first replaces the old id offset: it is the same
 * rotation (every company comes up once before any comes up twice) but it
 * survives boards being added, deactivated or reordered, and `last_polled_at`
 * doubles as the "polled within 6h" coverage check. Never-polled rows sort
 * first.
 *
 * The stamp is written BEFORE the caller polls anything: a tick that dies
 * half-way must not re-poll the same shard forever while the rest starves.
 */
export async function getShard(env: Env, size: number): Promise<Company[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, name, source, board, tier FROM companies
		  WHERE active = 1
		  ORDER BY last_polled_at IS NOT NULL, last_polled_at, id
		  LIMIT ?1`,
	)
		.bind(size)
		.all<CompanyRow>();
	if (results.length === 0) return [];

	const now = new Date().toISOString();
	const stamp = env.DB.prepare(`UPDATE companies SET last_polled_at = ?1 WHERE id = ?2`);
	await env.DB.batch(results.map((row) => stamp.bind(now, row.id)));

	// A row whose `source` is no longer a known ATS is dropped rather than
	// crashing the tick — the seed can outrun the code.
	return results
		.map((row) => (isSourceId(row.source) ? { id: row.id, name: row.name, source: row.source, board: row.board, tier: row.tier } : null))
		.filter((company): company is Company => company !== null);
}

/**
 * Subset of `hashes` already in `jobs`, notified or not. The complement is what
 * is safe to insert.
 */
export async function existingHashes(env: Env, hashes: readonly string[]): Promise<Set<string>> {
	if (hashes.length === 0) return new Set();

	const groups = chunk(hashes, PARAM_CHUNK);
	const results = await env.DB.batch<{ dedupe_key: string }>(
		groups.map((group) =>
			env.DB.prepare(`SELECT dedupe_key FROM jobs WHERE dedupe_key IN (${group.map((_, index) => `?${index + 1}`).join(', ')})`).bind(
				...group,
			),
		),
	);

	const known = new Set<string>();
	for (const result of results) {
		for (const row of result.results) known.add(row.dedupe_key);
	}
	return known;
}

/**
 * Persist jobs as unsent outbox rows. `INSERT OR IGNORE` makes a re-run of the
 * same tick a no-op, so this is safe to call without a preceding
 * `existingHashes` check — that call only exists to skip needless writes.
 *
 * Returns the number of rows actually written.
 */
export async function insertJobs(env: Env, jobs: readonly PendingJob[]): Promise<number> {
	if (jobs.length === 0) return 0;

	const now = new Date().toISOString();
	const statement = env.DB.prepare(
		`INSERT OR IGNORE INTO jobs
		   (dedupe_key, company_id, external_id, company, title, location, url, posted_at, yoe_min, notified, created_at, fuzzy_key, locations,
		    status, source, sources, url_norm, tweet_url, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?6, 'new', ?12, ?12, ?13, ?14, ?10)`,
	);

	let written = 0;
	for (const group of chunk(jobs, PARAM_CHUNK)) {
		const results = await env.DB.batch(
			group.map(({ hash, fuzzy, companyId, job, source, tweetUrl }) =>
				statement.bind(
					hash,
					companyId,
					job.externalId,
					job.company,
					job.title,
					job.location,
					job.url,
					job.postedAt,
					job.yoeMin ?? null,
					now,
					fuzzy,
					source,
					// A conflict on the unique url_norm index makes INSERT OR IGNORE skip the row:
					// that is the global URL dedupe across every source.
					normalizeUrl(job.url),
					tweetUrl ?? null,
				),
			),
		);
		for (const result of results) written += result.meta.changes ?? 0;
	}
	return written;
}

/**
 * Oldest unsent rows, capped at `limit`. Ordered by insertion so a backlog
 * drains front to back instead of starving the earliest finds.
 */
export async function unnotified(env: Env, limit: number): Promise<UnnotifiedJob[]> {
	if (limit <= 0) return [];

	const { results } = await env.DB.prepare(
		`SELECT rowid AS id, dedupe_key, external_id, company, title, location, url, posted_at, yoe_min, locations, sources, tweet_url
		   FROM jobs
		  WHERE notified = 0
		  ORDER BY created_at, rowid
		  LIMIT ?1`,
	)
		.bind(limit)
		.all<JobRow>();

	return results.map((row) => ({
		id: row.id,
		hash: row.dedupe_key,
		sources: row.sources,
		tweetUrl: row.tweet_url,
		yoeMin: row.yoe_min,
		job: {
			externalId: row.external_id,
			company: row.company,
			title: row.title,
			// The merged list when later sightings added places to this job.
			location: row.locations ?? row.location,
			url: row.url,
			postedAt: row.posted_at,
		},
	}));
}

/**
 * Flip rows to sent. Call only AFTER Telegram has accepted the message — a row
 * left at `notified = 0` is retried next tick, which is the point of inserting
 * before sending.
 */
export async function markNotified(env: Env, hashes: readonly string[]): Promise<number> {
	if (hashes.length === 0) return 0;

	const now = new Date().toISOString();
	const statement = env.DB.prepare(`UPDATE jobs SET notified = 1, notified_at = ?1 WHERE dedupe_key = ?2 AND notified = 0`);

	let updated = 0;
	for (const group of chunk(hashes, PARAM_CHUNK)) {
		const results = await env.DB.batch(group.map((hash) => statement.bind(now, hash)));
		for (const result of results) updated += result.meta.changes ?? 0;
	}
	return updated;
}

/**
 * Errors are data, not log lines — a cron trigger never retries, so a failure
 * that only reached console is a failure nobody can see. Swallows its own
 * write failure: if D1 is down there is nothing left to write to, and throwing
 * here would mask the original error.
 */
export async function logError(env: Env, company: string | null, msg: string, stage = 'tick'): Promise<void> {
	try {
		await env.DB.prepare(`INSERT INTO errors (ts, company, stage, message) VALUES (?1, ?2, ?3, ?4)`)
			.bind(new Date().toISOString(), company, stage, msg.slice(0, 2000))
			.run();
	} catch (error) {
		// D1 itself is unavailable. Console is the only place left to say so: `wrangler tail` shows it.
		console.error(`logError could not write (${stage}): ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** An existing job row the fuzzy key matched inside the dedupe window. */
export interface RecentMatch {
	dedupeKey: string;
	locations: string;
}

/**
 * Jobs created since `sinceIso` whose fuzzy key is in `keys`. A hit means the
 * same company and title was already queued, so the new sighting is merged into
 * it rather than inserted and sent a second time.
 */
export async function recentByFuzzy(env: Env, keys: readonly string[], sinceIso: string): Promise<Map<string, RecentMatch>> {
	const found = new Map<string, RecentMatch>();
	if (keys.length === 0) return found;

	const results = await env.DB.batch<{ fuzzy_key: string; dedupe_key: string; location: string; locations: string | null }>(
		chunk(keys, PARAM_CHUNK - 1).map((group) =>
			env.DB.prepare(
				`SELECT fuzzy_key, dedupe_key, location, locations FROM jobs
				  WHERE created_at >= ?1 AND fuzzy_key IN (${group.map((_, index) => `?${index + 2}`).join(', ')})
				  ORDER BY created_at`,
			).bind(sinceIso, ...group),
		),
	);
	for (const result of results) {
		for (const row of result.results) {
			// Oldest row wins: it is the one that was (or will be) sent.
			if (!found.has(row.fuzzy_key)) found.set(row.fuzzy_key, { dedupeKey: row.dedupe_key, locations: row.locations ?? row.location });
		}
	}
	return found;
}

/** Write merged location lists back. Does not touch `notified`, so nothing is re-sent. */
export async function updateLocations(env: Env, rows: ReadonlyArray<{ dedupeKey: string; locations: string }>): Promise<void> {
	if (rows.length === 0) return;
	const statement = env.DB.prepare(`UPDATE jobs SET locations = ?1 WHERE dedupe_key = ?2`);
	await env.DB.batch(rows.map((row) => statement.bind(row.locations, row.dedupeKey)));
}

/**
 * Which of `norms` already have a row, keyed by url_norm. The global URL dedupe:
 * a posting another source (or an earlier run) already queued is never queued twice.
 */
export async function findByUrlNorm(env: Env, norms: readonly string[]): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	if (norms.length === 0) return found;

	const results = await env.DB.batch<{ url_norm: string; dedupe_key: string }>(
		chunk(norms, PARAM_CHUNK).map((group) =>
			env.DB.prepare(`SELECT url_norm, dedupe_key FROM jobs WHERE url_norm IN (${group.map((_, index) => `?${index + 1}`).join(', ')})`).bind(...group),
		),
	);
	for (const result of results) {
		for (const row of result.results) found.set(row.url_norm, row.dedupe_key);
	}
	return found;
}

/**
 * Record another source that reported an existing job. Does not touch `notified`
 * or `status`, so a duplicate sighting never re-sends or reopens anything.
 */
export async function addSources(env: Env, rows: ReadonlyArray<{ dedupeKey: string; source: string }>): Promise<void> {
	if (rows.length === 0) return;
	const now = new Date().toISOString();
	const statement = env.DB.prepare(
		`UPDATE jobs SET sources = CASE
		     WHEN sources IS NULL OR sources = '' THEN ?1
		     WHEN instr(',' || sources || ',', ',' || ?1 || ',') > 0 THEN sources
		     ELSE sources || ',' || ?1
		   END,
		   updated_at = COALESCE(updated_at, ?3)
		 WHERE dedupe_key = ?2`,
	);
	await env.DB.batch(rows.map((row) => statement.bind(row.source, row.dedupeKey, now)));
}

/** Funnel counters for one company in one tick, or the tick total (see 0006). */
export interface RunCounts {
	fetched: number;
	newIds: number;
	passedTitle: number;
	passedLocation: number;
	passedFresh: number;
	detailed: number;
	passedDescription: number;
	passedYoe: number;
	unknownYoeBlocked: number;
	deduped: number;
	queued: number;
}

export function emptyCounts(): RunCounts {
	return {
		fetched: 0,
		newIds: 0,
		passedTitle: 0,
		passedLocation: 0,
		passedFresh: 0,
		detailed: 0,
		passedDescription: 0,
		passedYoe: 0,
		unknownYoeBlocked: 0,
		deduped: 0,
		queued: 0,
	};
}

export type ErrorKind = 'subrequest_limit' | 'timeout' | 'http' | 'not_found' | 'other';

/** Bucket a caught error so `source_runs` can answer "is it the limits?" with a GROUP BY. */
export function classifyError(message: string): ErrorKind {
	if (/too many subrequests|subrequest/i.test(message)) return 'subrequest_limit';
	if (/timeout|timed out|aborted/i.test(message)) return 'timeout';
	// A 404 on the BOARD (list) request. The tick downgrades a 404 from a single job's detail fetch to 'http'.
	if (/HTTP 404\b/.test(message)) return 'not_found';
	if (/HTTP \d{3}/.test(message)) return 'http';
	return 'other';
}

export interface CompanyRun {
	company: Company;
	counts: RunCounts;
	startedAt: string;
	wallMs: number;
	subrequests: number;
	errorKind: ErrorKind | null;
	error: string | null;
}

/**
 * Open the tick row. Written BEFORE any polling: a tick killed by the CPU limit
 * never reaches its own finish, and this row staying unfinished is the only
 * trace it leaves.
 */
export async function startTickRun(env: Env, runId: string, startedAt: string): Promise<void> {
	try {
		await env.DB.prepare(`INSERT INTO source_runs (run_id, kind, started_at) VALUES (?1, 'tick', ?2)`).bind(runId, startedAt).run();
	} catch {
		// Telemetry must never take the tick down with it.
	}
}

export interface TickTotals {
	counts: RunCounts;
	sent: number;
	errors: number;
	subrequests: number;
	wallMs: number;
}

/**
 * Close the tick row, write one row per company and update each company's
 * `fail_count`, all in one D1 round trip.
 */
export async function finishTickRun(env: Env, runId: string, totals: TickTotals, runs: readonly CompanyRun[]): Promise<void> {
	try {
		const finishedAt = new Date().toISOString();
		const close = env.DB.prepare(
			`UPDATE source_runs SET finished_at = ?1, fetched = ?2, new_ids = ?3, passed_title = ?4, passed_location = ?5,
			        passed_fresh = ?6, detailed = ?7, passed_description = ?8, passed_yoe = ?9, unknown_yoe_blocked = ?10,
			        deduped = ?11, queued = ?12, sent = ?13, errors = ?14, subrequests = ?15, wall_ms = ?16
			  WHERE run_id = ?17 AND kind = 'tick'`,
		).bind(
			finishedAt,
			totals.counts.fetched,
			totals.counts.newIds,
			totals.counts.passedTitle,
			totals.counts.passedLocation,
			totals.counts.passedFresh,
			totals.counts.detailed,
			totals.counts.passedDescription,
			totals.counts.passedYoe,
			totals.counts.unknownYoeBlocked,
			totals.counts.deduped,
			totals.counts.queued,
			totals.sent,
			totals.errors,
			totals.subrequests,
			totals.wallMs,
			runId,
		);

		const insert = env.DB.prepare(
			`INSERT INTO source_runs
			   (run_id, kind, started_at, finished_at, company_id, company, source, fetched, new_ids, passed_title, passed_location,
			    passed_fresh, detailed, passed_description, passed_yoe, unknown_yoe_blocked, deduped, queued, errors, wall_ms,
			    subrequests, error_kind, error)
			 VALUES (?1, 'company', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)`,
		);
		// A good poll clears both counters. Only a board 404 extends the run of 404s: any other
		// failure (a timeout, a 500) ends it, because "5 in a row" must mean 5 in a row.
		// The WHERE keeps a healthy board from being rewritten on every poll: D1's free plan allows 100,000 row
		// writes a day and an UPDATE that changes nothing still counts as one.
		const ok = env.DB.prepare(`UPDATE companies SET fail_count = 0, consec_404 = 0 WHERE id = ?1 AND (fail_count != 0 OR consec_404 != 0)`);
		const bad = env.DB.prepare(`UPDATE companies SET fail_count = fail_count + 1, consec_404 = 0 WHERE id = ?1`);
		const missing = env.DB.prepare(`UPDATE companies SET fail_count = fail_count + 1, consec_404 = consec_404 + 1 WHERE id = ?1`);
		// `retire` runs after `missing` in the same batch, so it sees the new count, and `retired`
		// runs after `retire`. The error row is what makes the switch-off visible: nothing else says
		// a board went quiet on purpose. A switched-off board is never polled again, so it logs once.
		const retire = env.DB.prepare(`UPDATE companies SET active = 0 WHERE id = ?1 AND active = 1 AND consec_404 >= ?2`);
		const retired = env.DB.prepare(
			`INSERT INTO errors (ts, company, stage, message)
			 SELECT ?1, name, 'auto-disable', 'switched off after ' || consec_404 || ' consecutive 404s from ' || source || ':' || board
			   FROM companies WHERE id = ?2 AND active = 0 AND consec_404 >= ?3`,
		);

		const statements: D1PreparedStatement[] = [close];
		for (const run of runs) {
			const { counts } = run;
			// A poll that found nothing new and did not fail is already counted in the tick row. Giving it
			// a row of its own costs 4 writes (the row and its 3 indexes) 3 times a tick, around 8,600 a day,
			// for a line that only says "nothing happened".
			const quiet = run.error === null && counts.newIds === 0;
			if (!quiet) {
				statements.push(
					insert.bind(
						runId,
						run.startedAt,
						finishedAt,
						run.company.id,
						run.company.name,
						run.company.source,
						counts.fetched,
						counts.newIds,
						counts.passedTitle,
						counts.passedLocation,
						counts.passedFresh,
						counts.detailed,
						counts.passedDescription,
						counts.passedYoe,
						counts.unknownYoeBlocked,
						counts.deduped,
						counts.queued,
						run.error === null ? 0 : 1,
						run.wallMs,
						run.subrequests,
						run.errorKind,
						run.error === null ? null : run.error.slice(0, 500),
					),
				);
			}
			statements.push(run.error === null ? ok.bind(run.company.id) : run.errorKind === 'not_found' ? missing.bind(run.company.id) : bad.bind(run.company.id));
			if (run.errorKind === 'not_found') {
				statements.push(retire.bind(run.company.id, AUTO_DISABLE_404S), retired.bind(finishedAt, run.company.id, AUTO_DISABLE_404S));
			}
		}
		await env.DB.batch(statements);
	} catch {
		// Same rule as startTickRun.
	}
}

/** Drop run rows past the retention window. Cheap enough to call occasionally. */
export async function pruneSourceRuns(env: Env, keepDays: number): Promise<void> {
	const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
	try {
		await env.DB.prepare(`DELETE FROM source_runs WHERE started_at < ?1`).bind(cutoff).run();
	} catch {
		// Best effort.
	}
}
