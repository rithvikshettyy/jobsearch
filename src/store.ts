import { isSourceId } from './sources';
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
	companyId: number;
	job: JobDetail;
}

/** An outbox row waiting to be pushed. */
export interface UnnotifiedJob {
	hash: string;
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
	dedupe_key: string;
	external_id: string;
	company: string;
	title: string;
	location: string;
	url: string;
	posted_at: string | null;
	yoe_min: number | null;
}

/**
 * Next `size` active companies on the rotation, cursor advanced.
 *
 * The cursor is written BEFORE the caller does any polling: a tick that dies
 * half-way must not re-poll the same shard forever while the rest of the table
 * starves. Wraps around the end of the table so every company comes up.
 */
export async function getShard(env: Env, size: number): Promise<Company[]> {
	const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM companies WHERE active = 1`).first<{ n: number }>();
	const total = countRow?.n ?? 0;
	if (total === 0) return [];

	const cursorRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'cursor'`).first<{ value: string }>();
	const parsed = Number.parseInt(cursorRow?.value ?? '0', 10);
	const cursor = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
	const offset = cursor % total;

	const select = `SELECT id, name, source, board, tier FROM companies WHERE active = 1 ORDER BY id LIMIT ?1 OFFSET ?2`;
	const wanted = Math.min(size, total);

	const head = await env.DB.prepare(select).bind(wanted, offset).all<CompanyRow>();
	const rows = [...head.results];
	if (rows.length < wanted) {
		const wrap = await env.DB.prepare(select)
			.bind(wanted - rows.length, 0)
			.all<CompanyRow>();
		rows.push(...wrap.results);
	}

	await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('cursor', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1`)
		.bind(String((offset + rows.length) % total))
		.run();

	// A row whose `source` is no longer a known ATS is dropped rather than
	// crashing the tick — the seed can outrun the code.
	return rows
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
		   (dedupe_key, company_id, external_id, company, title, location, url, posted_at, yoe_min, notified, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)`,
	);

	let written = 0;
	for (const group of chunk(jobs, PARAM_CHUNK)) {
		const results = await env.DB.batch(
			group.map(({ hash, companyId, job }) =>
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
		`SELECT dedupe_key, external_id, company, title, location, url, posted_at, yoe_min
		   FROM jobs
		  WHERE notified = 0
		  ORDER BY created_at, rowid
		  LIMIT ?1`,
	)
		.bind(limit)
		.all<JobRow>();

	return results.map((row) => ({
		hash: row.dedupe_key,
		yoeMin: row.yoe_min,
		job: {
			externalId: row.external_id,
			company: row.company,
			title: row.title,
			location: row.location,
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
	} catch {
		// D1 itself is unavailable.
	}
}
