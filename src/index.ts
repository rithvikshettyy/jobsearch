import {
	COMPANIES_PER_TICK,
	DEDUPE_WINDOW_DAYS,
	FILTERS,
	MAX_CONCURRENCY,
	MAX_DETAILS_PER_TICK,
	SEND_UNKNOWN_YOE,
	SOURCE_RUNS_KEEP_DAYS,
	SUBREQUEST_CAP,
} from './config';
import { markSeen, readSeenIds } from './db';
import { collapseByFuzzy, dedupeKey, fuzzyKey, mergeLocations } from './dedupe';
import { createLimiter, SubrequestBudget } from './limit';
import { handleIngest } from './ingest';
import { pushOutbox } from './outbox';
import { handleJobStatus, handleQueue } from './queue';
import { handleTelegramWebhook } from './webhook';
import { handleXAlert, handleXState, handleXStateWrite } from './x';
import { detailGate, lightGate } from './pipeline';
import { getSource } from './sources';
import {
	addSources,
	classifyError,
	emptyCounts,
	existingHashes,
	finishTickRun,
	getShard,
	insertJobs,
	logError,
	pruneSourceRuns,
	recentByFuzzy,
	startTickRun,
	updateLocations,
	type CompanyRun,
	type PendingJob,
	type RunCounts,
} from './store';
import type { Company, Env, Job, TickResult } from './types';

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

/** Subrequest counter scoped to one company, backed by the shared tick budget. */
function scopedBudget(budget: SubrequestBudget): { take(n?: number): boolean; readonly used: number } {
	let used = 0;
	return {
		take(n = 1): boolean {
			const ok = budget.take(n);
			if (ok) used += n;
			return ok;
		},
		get used(): number {
			return used;
		},
	};
}

type CompanyBudget = ReturnType<typeof scopedBudget>;

/**
 * Phase 1 for one company: one light request, ids diffed against `seen_postings`.
 * Never fetches a description body — that is what keeps the poll path inside the
 * subrequest cap.
 */
async function pollCompany(env: Env, company: Company, budget: CompanyBudget, counts: RunCounts): Promise<Job[]> {
	if (!budget.take(1)) return [];
	const jobs = await getSource(company.source).fetchJobs(company, env);
	counts.fetched = jobs.length;

	const seen = await readSeenIds(env, company.id);
	const unseen = jobs.filter((job) => !seen.has(job.externalId));
	counts.newIds = unseen.length;
	return unseen;
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
	budget: CompanyBudget,
	reserve: (wanted: number) => number,
	now: number,
	nowIso: string,
	counts: RunCounts,
	sendUnknownYoe: boolean,
): Promise<PendingJob[]> {
	const light = lightGate(unseen, FILTERS, now);
	counts.passedTitle = light.counts.title;
	counts.passedLocation = light.counts.location;
	counts.passedFresh = light.counts.fresh;
	await markSeen(env, company.id, light.rejected, nowIso);
	if (light.shortlist.length === 0) return [];

	const source = getSource(company.source);
	const batch = light.shortlist.slice(0, reserve(light.shortlist.length));
	if (batch.length === 0) return [];
	if (!budget.take(source.detailCost(batch.length))) return [];

	const details = await source.fetchDetails(company, batch, env);
	counts.detailed = batch.length;
	await markSeen(
		env,
		company.id,
		batch.map((job) => job.externalId),
		nowIso,
	);

	const pending: PendingJob[] = [];
	for (const detail of details) {
		const outcome = detailGate(detail, FILTERS, { sendUnknownYoe });
		if (!outcome.ok) {
			// A YOE rejection passed the description gate, so it still counts there.
			if (outcome.reason !== 'description') counts.passedDescription += 1;
			if (outcome.reason === 'unknown_yoe') counts.unknownYoeBlocked += 1;
			continue;
		}
		counts.passedDescription += 1;
		counts.passedYoe += 1;

		pending.push({
			hash: await dedupeKey(detail.company, detail.title, detail.location),
			fuzzy: await fuzzyKey(detail.company, detail.title),
			companyId: company.id,
			job: { ...detail, yoeMin: outcome.yoeMin },
			source: company.source,
		});
	}

	return pending;
}

/**
 * Fold pending jobs into the queue: collapse same-role duplicates inside this
 * run, then merge anything already queued in the last DEDUPE_WINDOW_DAYS into
 * the existing row instead of inserting it again.
 */
async function dedupePending(env: Env, pending: PendingJob[], now: number): Promise<PendingJob[]> {
	const collapsed = collapseByFuzzy(pending);
	const since = new Date(now - DEDUPE_WINDOW_DAYS * 86_400_000).toISOString();
	const recent = await recentByFuzzy(
		env,
		collapsed.kept.map((item) => item.fuzzy),
		since,
	);

	const fresh: PendingJob[] = [];
	const updates: Array<{ dedupeKey: string; locations: string }> = [];
	const sightings: Array<{ dedupeKey: string; source: string }> = [];
	for (const item of collapsed.kept) {
		const match = recent.get(item.fuzzy);
		if (match === undefined) {
			fresh.push(item);
			continue;
		}
		const merged = mergeLocations(match.locations, item.job.location);
		if (merged !== match.locations) updates.push({ dedupeKey: match.dedupeKey, locations: merged });
		sightings.push({ dedupeKey: match.dedupeKey, source: item.source });
	}
	await updateLocations(env, updates);
	await addSources(env, sightings);

	return fresh;
}

/**
 * One cron tick: poll a shard, detail only what is new, persist, then push.
 *
 * Every per-company call is wrapped — a cron trigger gets no retry, so one bad
 * board must not sink the rest of the shard, and the failure goes to `errors`
 * rather than to a console nobody reads.
 *
 * Telemetry: a tick row is opened before any polling and closed at the end, with
 * one `source_runs` row per company in between. An unclosed tick row is a tick
 * that was killed (CPU limit), which no handler can observe.
 */
export async function runTick(env: Env): Promise<TickResult> {
	const budget = new SubrequestBudget(SUBREQUEST_CAP);
	const reserve = createReserve(MAX_DETAILS_PER_TICK);
	const limit = createLimiter(MAX_CONCURRENCY);
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	const runId = crypto.randomUUID();
	const sendUnknownYoe = env.SEND_UNKNOWN_YOE === undefined ? SEND_UNKNOWN_YOE : env.SEND_UNKNOWN_YOE === 'true';

	await startTickRun(env, runId, nowIso);

	// getShard stamps last_polled_at before any polling happens: a tick that dies
	// half-way must not re-poll the same shard forever while the rest starves.
	const companies = await getShard(env, COMPANIES_PER_TICK);

	let polled = 0;
	let errors = 0;
	const runs: CompanyRun[] = [];
	const pending: PendingJob[] = [];

	await Promise.all(
		companies.map((company) =>
			limit(async (): Promise<void> => {
				const counts = emptyCounts();
				const scoped = scopedBudget(budget);
				const startedAt = Date.now();
				const run: CompanyRun = {
					company,
					counts,
					startedAt: new Date(startedAt).toISOString(),
					wallMs: 0,
					subrequests: 0,
					errorKind: null,
					error: null,
				};
				// Which request failed matters: a 404 on the board means the board is gone, a 404 on one
				// job's detail only means that posting was just taken down.
				let phase: 'poll' | 'detail' = 'poll';
				try {
					const unseen = await pollCompany(env, company, scoped, counts);
					polled += 1;
					if (unseen.length > 0) {
						phase = 'detail';
						pending.push(...(await detailCompany(env, company, unseen, scoped, reserve, now, nowIso, counts, sendUnknownYoe)));
					}
				} catch (error) {
					errors += 1;
					const message = describe(error);
					run.error = message;
					const kind = classifyError(message);
					run.errorKind = kind === 'not_found' && phase === 'detail' ? 'http' : kind;
					await logError(env, company.name, message, 'company');
				} finally {
					run.wallMs = Date.now() - startedAt;
					run.subrequests = scoped.used;
					runs.push(run);
				}
			}),
		),
	);

	let deduped = 0;
	let queued = 0;
	try {
		const fresh = await dedupePending(env, pending, now);
		// `insertJobs` is INSERT OR IGNORE, so this filter only saves writes — it
		// is not what makes the dedupe correct.
		const known = await existingHashes(
			env,
			fresh.map((job) => job.hash),
		);
		const toInsert = fresh.filter((job) => !known.has(job.hash));
		queued = await insertJobs(env, toInsert);
		deduped = pending.length - toInsert.length;

		// Attribute the dedupe outcome back to each company's funnel row.
		const queuedBy = new Map<number, number>();
		for (const job of toInsert) queuedBy.set(job.companyId, (queuedBy.get(job.companyId) ?? 0) + 1);
		const pendingBy = new Map<number, number>();
		for (const job of pending) pendingBy.set(job.companyId, (pendingBy.get(job.companyId) ?? 0) + 1);
		for (const run of runs) {
			run.counts.queued = queuedBy.get(run.company.id) ?? 0;
			run.counts.deduped = (pendingBy.get(run.company.id) ?? 0) - run.counts.queued;
		}
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

	const funnel = emptyCounts();
	for (const run of runs) {
		for (const key of Object.keys(funnel) as Array<keyof RunCounts>) funnel[key] += run.counts[key];
	}
	funnel.deduped = deduped;
	funnel.queued = queued;

	await finishTickRun(env, runId, { counts: funnel, sent: notified, errors, subrequests: budget.spent, wallMs: Date.now() - now }, runs);
	// Hourly is plenty: ~720 ticks a day each write ~9 rows.
	if (new Date(now).getUTCMinutes() < 2) await pruneSourceRuns(env, SOURCE_RUNS_KEEP_DAYS);

	return {
		runId,
		companies: companies.map((company) => company.name),
		polled,
		newIds: funnel.newIds,
		detailed: funnel.detailed,
		notified,
		errors,
		subrequests: budget.spent,
		funnel,
	};
}

interface HealthCounts {
	companies: number;
	seenPostings: number;
	jobs: number;
	pending: number;
	errors: number;
	/** Active companies not polled in the last 6h. Should be 0 when sharding keeps up. */
	stale6h: number;
	/** Ticks in the last 24h that opened a source_runs row and never closed it: killed by a limit. */
	unfinishedTicks24h: number;
}

/** Row counts straight out of D1 — also the liveness check on the binding. */
async function readCounts(env: Env): Promise<HealthCounts> {
	const [companies, seen, jobs, pending, errors, stale, unfinished] = await env.DB.batch<{ n: number | string | null }>([
		env.DB.prepare(`SELECT COUNT(*) AS n FROM companies WHERE active = 1`),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM seen_postings`),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs`),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE notified = 0`),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM errors`),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM companies WHERE active = 1 AND (last_polled_at IS NULL OR last_polled_at < ?1)`).bind(
			new Date(Date.now() - 6 * 3_600_000).toISOString(),
		),
		env.DB.prepare(`SELECT COUNT(*) AS n FROM source_runs WHERE kind = 'tick' AND finished_at IS NULL AND started_at > ?1 AND started_at < ?2`).bind(
			new Date(Date.now() - 24 * 3_600_000).toISOString(),
			new Date(Date.now() - 5 * 60_000).toISOString(),
		),
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
		stale6h: count(stale),
		unfinishedTicks24h: count(unfinished),
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

		if (request.method === 'POST' && url.pathname === '/ingest') return handleIngest(request, env);
		if (request.method === 'POST' && url.pathname === '/tg-webhook') return handleTelegramWebhook(request, env);
		if (request.method === 'GET' && url.pathname === '/queue') return handleQueue(request, env);

		if (url.pathname === '/x/state') {
			if (request.method === 'GET') return handleXState(request, env);
			if (request.method === 'POST') return handleXStateWrite(request, env);
		}
		if (request.method === 'POST' && url.pathname === '/x/alert') return handleXAlert(request, env);

		const statusRoute = /^\/jobs\/(\d+)\/status$/.exec(url.pathname);
		if (request.method === 'POST' && statusRoute?.[1] !== undefined) return handleJobStatus(request, env, Number(statusRoute[1]));

		return new Response('not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
