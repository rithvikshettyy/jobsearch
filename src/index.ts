import { COMPANIES_PER_TICK, FILTERS, JOBS_PER_MESSAGE, MAX_CONCURRENCY, MAX_DETAILS_PER_TICK, SUBREQUEST_CAP } from './config';
import { dedupeKey } from './dedupe';
import { filterUnnotified, markSeen, readCursor, readSeenIds, recordError, recordNotified, selectShard, writeCursor } from './db';
import { passesDetailFilters, passesLightFilters } from './filters';
import { createLimiter, SubrequestBudget } from './limit';
import { getSource } from './sources';
import { buildMessages, sendMessage } from './telegram';
import type { Company, Env, Job, TickResult } from './types';

interface Poll {
	company: Company;
	jobs: Job[];
}

interface Candidate {
	company: Company;
	job: Job;
	key: string;
}

/**
 * Phase 1. One light request per company, capped at MAX_CONCURRENCY in flight.
 * A company that throws is logged to `errors` and dropped from this tick — a
 * cron trigger gets no retry, so one bad board must not sink the others.
 */
async function pollCompanies(env: Env, companies: Company[], budget: SubrequestBudget): Promise<{ polls: Poll[]; errors: number }> {
	const limit = createLimiter(MAX_CONCURRENCY);
	let errors = 0;

	const settled = await Promise.all(
		companies.map((company) =>
			limit(async (): Promise<Poll | null> => {
				if (!budget.take(1)) return null;
				try {
					return { company, jobs: await getSource(company.source).fetchJobs(company) };
				} catch (error) {
					errors += 1;
					await recordError(env, 'poll', company.name, error);
					return null;
				}
			}),
		),
	);

	return { polls: settled.filter((poll): poll is Poll => poll !== null), errors };
}

/**
 * Phase 2. Only ids absent from `seen_postings` reach here, and only after the
 * light filters have already thrown out the obvious misses — that is what keeps
 * JD fetches inside the subrequest budget.
 */
async function collectCandidates(
	env: Env,
	polls: Poll[],
	budget: SubrequestBudget,
	now: number,
): Promise<{ candidates: Candidate[]; newIds: number; detailed: number; errors: number }> {
	const candidates: Candidate[] = [];
	const nowIso = new Date(now).toISOString();
	let newIds = 0;
	let detailed = 0;
	let errors = 0;
	let detailsLeft = MAX_DETAILS_PER_TICK;

	for (const { company, jobs } of polls) {
		try {
			const seen = await readSeenIds(env, company.id);
			const unseen = jobs.filter((job) => !seen.has(job.externalId));
			newIds += unseen.length;
			if (unseen.length === 0) continue;

			const shortlist: Job[] = [];
			const rejected: string[] = [];
			for (const job of unseen) {
				if (passesLightFilters(job, FILTERS, now)) shortlist.push(job);
				else rejected.push(job.externalId);
			}
			// Rejected ids are settled: record them so they never cost a fetch again.
			await markSeen(env, company.id, rejected, nowIso);

			const source = getSource(company.source);
			const batch = shortlist.slice(0, detailsLeft);
			if (batch.length === 0) continue;
			if (!budget.take(source.detailCost(batch.length))) continue;

			const details = await source.fetchDetails(company, batch);
			detailed += batch.length;
			detailsLeft -= batch.length;

			// Marked seen only once the detail fetch actually succeeded, so a failed
			// batch is retried next tick instead of being lost.
			await markSeen(
				env,
				company.id,
				batch.map((job) => job.externalId),
				nowIso,
			);

			for (const detail of details) {
				if (!passesDetailFilters(detail, FILTERS)) continue;
				candidates.push({ company, job: detail, key: await dedupeKey(detail.company, detail.title, detail.location) });
			}
		} catch (error) {
			errors += 1;
			await recordError(env, 'detail', company.name, error);
		}
	}

	return { candidates, newIds, detailed, errors };
}

async function notify(env: Env, candidates: Candidate[], budget: SubrequestBudget): Promise<{ notified: number; errors: number }> {
	if (candidates.length === 0) return { notified: 0, errors: 0 };

	const unnotified = await filterUnnotified(
		env,
		candidates.map((candidate) => candidate.key),
	);
	const fresh = candidates.filter((candidate) => unnotified.has(candidate.key));
	if (fresh.length === 0) return { notified: 0, errors: 0 };

	const nowIso = new Date().toISOString();
	let notified = 0;
	let errors = 0;

	for (let index = 0; index < fresh.length; index += JOBS_PER_MESSAGE) {
		const chunk = fresh.slice(index, index + JOBS_PER_MESSAGE);
		const [message] = buildMessages(
			chunk.map((candidate) => candidate.job),
			JOBS_PER_MESSAGE,
		);
		if (message === undefined) continue;
		if (!budget.take(1)) break;
		try {
			await sendMessage(env, message);
			// Recorded only after a successful send — an unsent job stays eligible.
			await recordNotified(
				env,
				chunk.map((candidate) => ({ key: candidate.key, companyId: candidate.company.id, job: candidate.job })),
				nowIso,
			);
			notified += chunk.length;
		} catch (error) {
			errors += 1;
			await recordError(env, 'notify', null, error);
		}
	}

	return { notified, errors };
}

export async function runTick(env: Env): Promise<TickResult> {
	const budget = new SubrequestBudget(SUBREQUEST_CAP);
	const now = Date.now();

	const cursor = await readCursor(env);
	const { companies, nextCursor } = await selectShard(env, cursor, COMPANIES_PER_TICK);
	// Advance the cursor first: a tick that dies mid-way must not re-poll the
	// same shard forever while the rest of the table starves.
	await writeCursor(env, nextCursor);

	const polled = await pollCompanies(env, companies, budget);
	const collected = await collectCandidates(env, polled.polls, budget, now);
	const sent = await notify(env, collected.candidates, budget);

	return {
		companies: companies.map((company) => company.name),
		polled: polled.polls.length,
		newIds: collected.newIds,
		detailed: collected.detailed,
		notified: sent.notified,
		errors: polled.errors + collected.errors + sent.errors,
		subrequests: budget.spent,
	};
}

export default {
	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		try {
			await runTick(env);
		} catch (error) {
			await recordError(env, 'tick', null, error);
		}
	},

	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/health') {
			return Response.json({ ok: true });
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
