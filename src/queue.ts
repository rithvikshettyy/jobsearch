import { requireIngestKey } from './auth';
import type { Env } from './types';

export const JOB_STATUSES = ['new', 'approved', 'skipped', 'applying', 'applied', 'failed', 'manual'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export function isJobStatus(value: string): value is JobStatus {
	return (JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * Where a job may go from each state.
 *
 * `new` only moves on a human tap. `applying` can drop back to `approved` so the
 * poller can release a job it claimed and then crashed on. `applied` is final.
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
	new: ['approved', 'skipped'],
	approved: ['applying', 'skipped', 'manual'],
	applying: ['applied', 'failed', 'manual', 'approved'],
	failed: ['approved', 'skipped', 'manual'],
	manual: ['applied', 'skipped'],
	skipped: ['approved'],
	applied: [],
};

export function canMove(from: JobStatus, to: JobStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

export interface QueueJob {
	id: number;
	url: string;
	title: string;
	company: string;
	location: string;
	source: string | null;
	sources: string | null;
	status: JobStatus;
	yoeMin: number | null;
	tweetUrl: string | null;
	failReason: string | null;
	createdAt: string;
	updatedAt: string | null;
}

interface QueueRow {
	id: number;
	url: string;
	title: string;
	company: string;
	location: string;
	locations: string | null;
	source: string | null;
	sources: string | null;
	status: string;
	yoe_min: number | null;
	tweet_url: string | null;
	fail_reason: string | null;
	created_at: string;
	updated_at: string | null;
}

const SELECT_JOB = `SELECT rowid AS id, url, title, company, location, locations, source, sources, status, yoe_min, tweet_url, fail_reason, created_at, updated_at FROM jobs`;

function toQueueJob(row: QueueRow): QueueJob {
	return {
		id: row.id,
		url: row.url,
		title: row.title,
		company: row.company,
		// The merged list when later sightings added places.
		location: row.locations ?? row.location,
		source: row.source,
		sources: row.sources,
		status: isJobStatus(row.status) ? row.status : 'new',
		yoeMin: row.yoe_min,
		tweetUrl: row.tweet_url,
		failReason: row.fail_reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function getJob(env: Env, id: number): Promise<QueueJob | null> {
	const row = await env.DB.prepare(`${SELECT_JOB} WHERE rowid = ?1`).bind(id).first<QueueRow>();
	return row === null ? null : toQueueJob(row);
}

/** Oldest decision first, so the poller drains the queue in the order it was approved. */
export async function listQueue(env: Env, status: JobStatus, limit: number): Promise<QueueJob[]> {
	const { results } = await env.DB.prepare(`${SELECT_JOB} WHERE status = ?1 ORDER BY COALESCE(updated_at, created_at), rowid LIMIT ?2`)
		.bind(status, limit)
		.all<QueueRow>();
	return results.map(toQueueJob);
}

export type MoveResult = { ok: true; job: QueueJob } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'conflict'; from: JobStatus };

/**
 * Move a job to `to` if the table allows it from where it is now.
 *
 * One conditional UPDATE, so two taps (or a tap and the poller) racing on the
 * same job cannot both win. `onlyFrom` narrows it further: the Telegram buttons
 * pass 'new', so a stale button can never reopen a skipped job.
 */
export async function moveJob(env: Env, id: number, to: JobStatus, options: { failReason?: string | null; onlyFrom?: JobStatus } = {}): Promise<MoveResult> {
	let allowedFrom = JOB_STATUSES.filter((from) => canMove(from, to));
	if (options.onlyFrom !== undefined) allowedFrom = allowedFrom.filter((from) => from === options.onlyFrom);

	if (allowedFrom.length > 0) {
		const reason = to === 'failed' || to === 'manual' ? (options.failReason ?? null) : null;
		const result = await env.DB.prepare(
			`UPDATE jobs SET status = ?1, fail_reason = ?2, updated_at = ?3
			  WHERE rowid = ?4 AND status IN (${allowedFrom.map((_, index) => `?${index + 5}`).join(', ')})`,
		)
			.bind(to, reason === null ? null : reason.slice(0, 300), new Date().toISOString(), id, ...allowedFrom)
			.run();
		if ((result.meta.changes ?? 0) > 0) {
			const job = await getJob(env, id);
			if (job !== null) return { ok: true, job };
		}
	}

	const current = await getJob(env, id);
	if (current === null) return { ok: false, reason: 'not_found' };
	return { ok: false, reason: 'conflict', from: current.status };
}

/** GET /queue?status=approved&limit=20 */
export async function handleQueue(request: Request, env: Env): Promise<Response> {
	const denied = await requireIngestKey(request, env);
	if (denied !== null) return denied;

	const url = new URL(request.url);
	const status = url.searchParams.get('status') ?? 'approved';
	if (!isJobStatus(status)) return Response.json({ error: `status must be one of ${JOB_STATUSES.join(', ')}` }, { status: 400 });

	const wanted = Number(url.searchParams.get('limit') ?? '20');
	const limit = Number.isInteger(wanted) && wanted >= 1 ? Math.min(wanted, 100) : 20;

	return Response.json({ status, jobs: await listQueue(env, status, limit) });
}

/** POST /jobs/:id/status  body: { "status": "applying", "fail_reason": "..." } */
export async function handleJobStatus(request: Request, env: Env, id: number): Promise<Response> {
	const denied = await requireIngestKey(request, env);
	if (denied !== null) return denied;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'body must be JSON' }, { status: 400 });
	}
	const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
	const status = typeof record.status === 'string' ? record.status : '';
	if (!isJobStatus(status)) return Response.json({ error: `status must be one of ${JOB_STATUSES.join(', ')}` }, { status: 400 });
	const failReason = typeof record.fail_reason === 'string' ? record.fail_reason : null;

	const moved = await moveJob(env, id, status, { failReason });
	if (moved.ok) return Response.json({ job: moved.job });
	if (moved.reason === 'not_found') return Response.json({ error: 'job not found' }, { status: 404 });
	return Response.json({ error: `cannot move a ${moved.from} job to ${status}` }, { status: 409 });
}
