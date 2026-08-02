import { COMPANIES_PER_TICK, FILTERS, JOBS_PER_MESSAGE, MAX_CONCURRENCY, MAX_DETAILS_PER_TICK, SUBREQUEST_CAP } from './config';
import { markSeen, readSeenIds } from './db';
import { dedupeKey } from './dedupe';
import { geoOk, isFresh, minYoe, passesDetailFilters, roleOk, yoeOk } from './filters';
import { createLimiter, SubrequestBudget } from './limit';
import { groupJobs, sendBatch, type NotifyJob } from './notify';
import { getSource } from './sources';
import { existingHashes, getShard, insertJobs, logError, markNotified, unnotified, type PendingJob } from './store';
import type { Company, Env, Job, TickResult } from './types';

/** Rows pulled from the outbox in one tick, on top of whatever this tick found. */
const MAX_NOTIFY_PER_TICK = 20;

function describe(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Shared, synchronously-reserved allowance for phase-2 fetches. Companies run
 * concurrently, so the counter has to be decremented before the first `await`
 * or two of them read the same remaining budget.
 */
function createReserve(total: number): (wanted: number) => number {
	let left = total;
	return (wanted: number): number => {
		const granted = Math.min(wanted, left);
		left -= granted;
		return granted;
	};
}

/**
 * Phase 1 for one company: one light request, ids diffed against `seen_postings`.
 * Never fetches a description body — that is what keeps the poll path inside the
 * subrequest cap.
 */
async function pollCompany(env: Env, company: Company, budget: SubrequestBudget): Promise<Job[]> {
	if (!budget.take(1)) return [];
	const jobs = await getSource(company.source).fetchJobs(company);

	const seen = await readSeenIds(env, company.id);
	return jobs.filter((job) => !seen.has(job.externalId));
}

/**
 * Phase 2 for one company. Only unseen ids arrive here, and only the ones that
 * already cleared the light gates get a JD fetch.
 *
 * Ids are marked seen in two places on purpose: a light-rejected id is settled
 * immediately so it never costs a fetch again, while a detailed id is marked
 * only AFTER `fetchDetails` resolves — a failed batch must stay retryable.
 */
async function detailCompany(
	env: Env,
	company: Company,
	unseen: Job[],
	budget: SubrequestBudget,
	reserve: (wanted: number) => number,
	now: number,
	nowIso: string,
): Promise<{ pending: PendingJob[]; detailed: number }> {
	const shortlist: Job[] = [];
	const rejected: string[] = [];
	for (const job of unseen) {
		const light = roleOk(job.title, FILTERS) && geoOk(job.location, FILTERS) && isFresh(job.postedAt, FILTERS, now);
		if (light) shortlist.push(job);
		else rejected.push(job.externalId);
	}
	await markSeen(env, company.id, rejected, nowIso);
	if (shortlist.length === 0) return { pending: [], detailed: 0 };

	const source = getSource(company.source);
	const batch = shortlist.slice(0, reserve(shortlist.length));
	if (batch.length === 0) return { pending: [], detailed: 0 };
	if (!budget.take(source.detailCost(batch.length))) return { pending: [], detailed: 0 };

	const details = await source.fetchDetails(company, batch);
	await markSeen(
		env,
		company.id,
		batch.map((job) => job.externalId),
		nowIso,
	);

	const pending: PendingJob[] = [];
	for (const detail of details) {
		// Work-authorization and geo clauses live in the JD, not the location
		// field, so the geo gate runs a second time over the description.
		if (!passesDetailFilters(detail, FILTERS)) continue;
		if (!geoOk(detail.description)) continue;
		if (!yoeOk(detail.description)) continue;

		pending.push({
			hash: await dedupeKey(detail.company, detail.title, detail.location),
			companyId: company.id,
			job: { ...detail, yoeMin: detail.yoeMin ?? minYoe(detail.description) },
		});
	}

	return { pending, detailed: batch.length };
}

/**
 * Drain the outbox. One subrequest per message group, and a row flips to
 * notified only once Telegram has accepted it — a failed group stays at
 * `notified = 0` for the next tick.
 */
async function pushOutbox(env: Env, budget: SubrequestBudget): Promise<{ notified: number; errors: number }> {
	const capacity = Math.min(MAX_NOTIFY_PER_TICK, budget.left * JOBS_PER_MESSAGE);
	if (capacity <= 0) return { notified: 0, errors: 0 };

	const rows = await unnotified(env, capacity);
	if (rows.length === 0) return { notified: 0, errors: 0 };

	const entries: NotifyJob[] = rows.map((row) => ({ hash: row.hash, job: row.job, yoeMin: row.yoeMin }));
	let notified = 0;
	let errors = 0;

	for (const group of groupJobs(entries, JOBS_PER_MESSAGE)) {
		if (!budget.take(1)) break;
		// The group is already inside both caps, so this is exactly one message.
		const result = await sendBatch(env, group, JOBS_PER_MESSAGE);
		await markNotified(env, result.sent);
		notified += result.sent.length;
		if (result.failed.length > 0) {
			errors += 1;
			await logError(env, null, `telegram send failed for ${result.failed.length} job(s)`, 'notify');
		}
	}

	return { notified, errors };
}

/**
 * One cron tick: poll a shard, detail only what is new, persist, then push.
 *
 * Every per-company call is wrapped — a cron trigger gets no retry, so one bad
 * board must not sink the rest of the shard, and the failure goes to `errors`
 * rather than to a console nobody reads.
 */
export async function runTick(env: Env): Promise<TickResult> {
	const budget = new SubrequestBudget(SUBREQUEST_CAP);
	const reserve = createReserve(MAX_DETAILS_PER_TICK);
	const limit = createLimiter(MAX_CONCURRENCY);
	const now = Date.now();
	const nowIso = new Date(now).toISOString();

	// getShard advances the cursor before any polling happens: a tick that dies
	// half-way must not re-poll the same shard forever while the rest starves.
	const companies = await getShard(env, COMPANIES_PER_TICK);

	let polled = 0;
	let newIds = 0;
	let detailed = 0;
	let errors = 0;
	const pending: PendingJob[] = [];

	await Promise.all(
		companies.map((company) =>
			limit(async (): Promise<void> => {
				try {
					const unseen = await pollCompany(env, company, budget);
					polled += 1;
					newIds += unseen.length;
					if (unseen.length === 0) return;

					const result = await detailCompany(env, company, unseen, budget, reserve, now, nowIso);
					detailed += result.detailed;
					pending.push(...result.pending);
				} catch (error) {
					errors += 1;
					await logError(env, company.name, describe(error), 'company');
				}
			}),
		),
	);

	try {
		// `insertJobs` is INSERT OR IGNORE, so this filter only saves writes — it
		// is not what makes the dedupe correct.
		const known = await existingHashes(
			env,
			pending.map((job) => job.hash),
		);
		await insertJobs(
			env,
			pending.filter((job) => !known.has(job.hash)),
		);
	} catch (error) {
		errors += 1;
		await logError(env, null, describe(error), 'persist');
	}

	let notified = 0;
	try {
		const sent = await pushOutbox(env, budget);
		notified = sent.notified;
		errors += sent.errors;
	} catch (error) {
		errors += 1;
		await logError(env, null, describe(error), 'notify');
	}

	return {
		companies: companies.map((company) => company.name),
		polled,
		newIds,
		detailed,
		notified,
		errors,
		subrequests: budget.spent,
	};
}

interface HealthCounts {
	companies: number;
	seenPostings: number;
	jobs: number;
	pending: number;
	errors: number;
	cursor: number;
}

/** Row counts straight out of D1 — also the liveness check on the binding. */
async function readCounts(env: Env): Promise<HealthCounts> {
	const [companies, seen, jobs, pending, errors, cursor] = await env.DB.batch<{ n: number | string | null }>([
		env.DB.prepare(`SELECT COUNT(*) AS n FROM companies WHERE active = 1`),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM seen_postings`),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs`),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE notified = 0`),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM errors`),
		env.DB.prepare(`SELECT value AS n FROM meta WHERE key = 'cursor'`),
	]);

	const count = (result: D1Result<{ n: number | string | null }>): number => {
		const parsed = Number(result.results[0]?.n ?? 0);
		return Number.isFinite(parsed) ? parsed : 0;
	};

	return {
		companies: count(companies),
		seenPostings: count(seen),
		jobs: count(jobs),
		pending: count(pending),
		errors: count(errors),
		cursor: count(cursor),
	};
}

export default {
	/**
	 * Cron entry point. Swallows at the top level as well: an uncaught throw here
	 * is invisible on a trigger that never retries.
	 */
	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		try {
			await runTick(env);
		} catch (error) {
			await logError(env, null, describe(error), 'tick');
		}
	},

	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/health') {
			try {
				return Response.json({ ok: true, counts: await readCounts(env) });
			} catch (error) {
				// D1 unreachable is exactly what /health exists to surface.
				return Response.json({ ok: false, error: describe(error) }, { status: 503 });
			}
		}

		if (request.method === 'POST' && url.pathname === '/run') {
			if (env.ADMIN_TOKEN !== undefined && request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
				return new Response('forbidden', { status: 403 });
			}
			return Response.json(await runTick(env));
		}

		return new Response('not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
