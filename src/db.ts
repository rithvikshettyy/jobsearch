import { isSourceId } from './sources';
import type { Company, Env, Job } from './types';

interface CompanyRow {
	id: number;
	name: string;
	source: string;
	board: string;
}

function toCompany(row: CompanyRow): Company | null {
	return isSourceId(row.source) ? { id: row.id, name: row.name, source: row.source, board: row.board } : null;
}

export async function readCursor(env: Env): Promise<number> {
	const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'cursor'`).first<{ value: string }>();
	const parsed = Number.parseInt(row?.value ?? '0', 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function writeCursor(env: Env, cursor: number): Promise<void> {
	await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('cursor', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1`)
		.bind(String(cursor))
		.run();
}

/**
 * Cursor-based shard. Takes `size` active companies starting at `cursor` and
 * wraps around the end of the table, so every company is polled on a fixed
 * rotation without a per-company "last polled" column.
 */
export async function selectShard(env: Env, cursor: number, size: number): Promise<{ companies: Company[]; nextCursor: number }> {
	const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM companies WHERE active = 1`).first<{ n: number }>();
	const total = countRow?.n ?? 0;
	if (total === 0) return { companies: [], nextCursor: 0 };

	const offset = cursor % total;
	const select = `SELECT id, name, source, board FROM companies WHERE active = 1 ORDER BY id LIMIT ?1 OFFSET ?2`;

	const head = await env.DB.prepare(select).bind(size, offset).all<CompanyRow>();
	const rows = [...head.results];
	if (rows.length < Math.min(size, total)) {
		const wrap = await env.DB.prepare(select)
			.bind(Math.min(size, total) - rows.length, 0)
			.all<CompanyRow>();
		rows.push(...wrap.results);
	}

	const companies = rows.map(toCompany).filter((company): company is Company => company !== null);
	return { companies, nextCursor: (offset + rows.length) % total };
}

/** Phase-1 diff set for one company. */
export async function readSeenIds(env: Env, companyId: number): Promise<Set<string>> {
	const { results } = await env.DB.prepare(`SELECT external_id FROM seen_postings WHERE company_id = ?1`)
		.bind(companyId)
		.all<{ external_id: string }>();
	return new Set(results.map((row) => row.external_id));
}

export async function markSeen(env: Env, companyId: number, externalIds: string[], now: string): Promise<void> {
	if (externalIds.length === 0) return;
	const statement = env.DB.prepare(`INSERT OR IGNORE INTO seen_postings (company_id, external_id, first_seen) VALUES (?1, ?2, ?3)`);
	await env.DB.batch(externalIds.map((externalId) => statement.bind(companyId, externalId, now)));
}

/** Keys already notified, so a repost under a new external id stays quiet. */
export async function filterUnnotified(env: Env, keys: string[]): Promise<Set<string>> {
	if (keys.length === 0) return new Set();
	const placeholders = keys.map((_, index) => `?${index + 1}`).join(', ');
	const { results } = await env.DB.prepare(`SELECT dedupe_key FROM jobs WHERE dedupe_key IN (${placeholders})`)
		.bind(...keys)
		.all<{ dedupe_key: string }>();
	const known = new Set(results.map((row) => row.dedupe_key));
	return new Set(keys.filter((key) => !known.has(key)));
}

export async function recordNotified(env: Env, rows: Array<{ key: string; companyId: number; job: Job }>, now: string): Promise<void> {
	if (rows.length === 0) return;
	const statement = env.DB.prepare(
		`INSERT OR IGNORE INTO jobs (dedupe_key, company_id, external_id, company, title, location, url, posted_at, notified_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
	);
	await env.DB.batch(
		rows.map(({ key, companyId, job }) =>
			statement.bind(key, companyId, job.externalId, job.company, job.title, job.location, job.url, job.postedAt, now),
		),
	);
}

/**
 * Errors are data, not log lines — a cron trigger never retries, so a failure
 * that only reached console is a failure nobody can see.
 */
export async function recordError(env: Env, stage: string, company: string | null, error: unknown): Promise<void> {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	try {
		await env.DB.prepare(`INSERT INTO errors (ts, company, stage, message) VALUES (?1, ?2, ?3, ?4)`)
			.bind(new Date().toISOString(), company, stage, message.slice(0, 2000))
			.run();
	} catch {
		// D1 itself is down; nothing left to write to.
	}
}
