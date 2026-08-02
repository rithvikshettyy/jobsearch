import { asIsoDate, asString, getJson, isRecord, stripHtml } from '../http';
import type { Company, Job, JobDetail, Source } from '../types';

const FEED = 'https://remotive.com/api/remote-jobs';

/**
 * Aggregator, not an employer board — one feed carries every company, so the
 * `board` column holds a category slug ("software-dev") or "all".
 */
function feedUrl(company: Company): string {
	return company.board === '' || company.board === 'all' ? FEED : `${FEED}?category=${encodeURIComponent(company.board)}`;
}

function readJobs(payload: unknown, board: string): Record<string, unknown>[] {
	if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
		throw new Error(`remotive: unexpected payload for feed "${board}"`);
	}
	return payload.jobs.filter(isRecord);
}

/**
 * `candidate_required_location` is the field that makes this feed usable — it
 * says who may actually take the job ("Worldwide", "USA", "India"), which is
 * exactly what `geoOk` needs. Falling back to the bare word "Remote" would
 * make every listing look eligible.
 */
function toJob(raw: Record<string, unknown>): Job | null {
	const externalId = asString(raw.id);
	if (externalId === '') return null;
	return {
		externalId,
		// The employer, not Remotive — the dedupe key is company|title|location,
		// so using the aggregator here would collapse unrelated jobs together.
		company: asString(raw.company_name),
		title: asString(raw.title),
		location: asString(raw.candidate_required_location, 'Remote'),
		url: asString(raw.url),
		postedAt: asIsoDate(raw.publication_date),
	};
}

export async function fetchJobs(company: Company): Promise<Job[]> {
	const rows = readJobs(await getJson(feedUrl(company), 20_000), company.board);
	const jobs: Job[] = [];
	for (const raw of rows) {
		const job = toJob(raw);
		if (job !== null) jobs.push(job);
	}
	return jobs;
}

/**
 * Descriptions ship inline on the feed, but `fetchJobs` deliberately drops them
 * — the poll path never reads a JD. One more feed fetch covers the whole batch,
 * so this costs 1 subrequest like Ashby, not one per job.
 */
export async function fetchDetails(company: Company, jobs: Job[]): Promise<JobDetail[]> {
	if (jobs.length === 0) return [];
	const rows = readJobs(await getJson(feedUrl(company), 20_000), company.board);

	const byId = new Map<string, Record<string, unknown>>();
	for (const raw of rows) byId.set(asString(raw.id), raw);

	return jobs.map((job) => {
		const raw = byId.get(job.externalId);
		return { ...job, description: raw ? stripHtml(asString(raw.description)) : '' };
	});
}

export function detailCost(n: number): number {
	return n === 0 ? 0 : 1;
}

export const remotive: Source = { fetchJobs, fetchDetails, detailCost };
