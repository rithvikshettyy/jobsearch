import { asIsoDate, asString, getJson, isRecord, stripHtml } from '../http';
import type { Company, Env, Job, JobDetail, Source } from '../types';

const HOST = 'jsearch.p.rapidapi.com';
const SEARCH = `https://${HOST}/search`;

/**
 * JSearch is the only reachable route to Indeed / ZipRecruiter / Glassdoor /
 * LinkedIn inventory — it licenses those listings, so this stays inside their
 * terms where scraping the sites directly would not (and could not: every one
 * of them is behind Cloudflare or reCAPTCHA).
 *
 * QUOTA — the free RapidAPI tier is 200 requests/MONTH. The cron in
 * wrangler.jsonc fires every 2 minutes and `getShard` rotates 8 companies per
 * tick, which spends that budget in well under a day. The seed row for this
 * source ships with `active = 0` for exactly that reason; see
 * migrations/0005_aggregator_sources.sql before switching it on.
 */
const RESULTS_PAGES = 1;

/**
 * `board` is a feed selector, not an employer slug:
 *
 *   query                     e.g. "software engineer in India"
 *   query|country             e.g. "python developer|in"
 *   query|country|date_posted e.g. "react developer|in|week"
 *
 * `date_posted` is one of all/today/3days/week/month. Narrowing it is the
 * cheapest way to keep a scarce request returning something new each call.
 */
interface Selector {
	query: string;
	country: string;
	datePosted: string;
}

function parseSelector(board: string): Selector {
	const [query = '', country = '', datePosted = ''] = board.split('|');
	const text = query.trim();
	if (text === '') throw new Error(`jsearch: board "${board}" has no query (expected "software engineer in India|in")`);
	return { query: text, country: country.trim().toLowerCase(), datePosted: datePosted.trim().toLowerCase() };
}

function feedUrl(company: Company): string {
	const { query, country, datePosted } = parseSelector(company.board);
	const params = new URLSearchParams({ query, page: '1', num_pages: String(RESULTS_PAGES) });
	if (country !== '') params.set('country', country);
	if (datePosted !== '') params.set('date_posted', datePosted);
	return `${SEARCH}?${params.toString()}`;
}

function authHeaders(env: Env): Record<string, string> {
	const key = env.RAPIDAPI_KEY ?? '';
	// Without the header RapidAPI answers 401 with a JSON body that parses fine
	// and yields zero jobs — a silent empty poll. Fail loudly instead.
	if (key === '') throw new Error('jsearch: RAPIDAPI_KEY is not set');
	return { 'x-rapidapi-key': key, 'x-rapidapi-host': HOST };
}

function readJobs(payload: unknown, board: string): Record<string, unknown>[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error(`jsearch: unexpected payload for feed "${board}"`);
	}
	return payload.data.filter(isRecord);
}

/**
 * JSearch splits the place across city/state/country and sets `job_is_remote`
 * separately. `geoOk` matches substrings against one string, so they are joined
 * here — and a remote row with no city would otherwise arrive as "" and match
 * nothing at all.
 */
function toLocation(raw: Record<string, unknown>): string {
	const parts = [asString(raw.job_city), asString(raw.job_state), asString(raw.job_country)].filter((part) => part !== '');
	if (raw.job_is_remote === true) parts.unshift('Remote');
	return parts.join(', ');
}

function toJob(raw: Record<string, unknown>): Job | null {
	const externalId = asString(raw.job_id);
	if (externalId === '') return null;
	return {
		externalId,
		// The employer, not the publisher. `job_publisher` is where JSearch found
		// it ("Indeed", "ZipRecruiter") and must not become the dedupe company —
		// the same role listed on two boards has to collapse to one key.
		company: asString(raw.employer_name, 'Unknown'),
		title: asString(raw.job_title),
		location: toLocation(raw),
		url: asString(raw.job_apply_link),
		postedAt: asIsoDate(raw.job_posted_at_datetime_utc),
	};
}

export async function fetchJobs(company: Company, env: Env): Promise<Job[]> {
	const rows = readJobs(await getJson(feedUrl(company), 20_000, authHeaders(env)), company.board);
	const jobs: Job[] = [];
	for (const raw of rows) {
		const job = toJob(raw);
		if (job !== null) jobs.push(job);
	}
	return jobs;
}

/**
 * `job_description` is the FULL text and ships inline on the search response, so
 * unlike Adzuna the detail gates work at full strength here. The poll path still
 * drops it — a source never reads a JD in phase 1 — and one refetch covers the
 * batch, hence `detailCost` of 1.
 *
 * That refetch is a second billed request against the monthly quota. Read the
 * QUOTA note at the top of this file before raising the cron cadence.
 */
export async function fetchDetails(company: Company, jobs: Job[], env: Env): Promise<JobDetail[]> {
	if (jobs.length === 0) return [];
	const rows = readJobs(await getJson(feedUrl(company), 20_000, authHeaders(env)), company.board);

	const byId = new Map<string, Record<string, unknown>>();
	for (const raw of rows) byId.set(asString(raw.job_id), raw);

	return jobs.map((job) => {
		const raw = byId.get(job.externalId);
		return { ...job, description: raw ? stripHtml(asString(raw.job_description)) : '' };
	});
}

export function detailCost(n: number): number {
	return n === 0 ? 0 : 1;
}

export const jsearch: Source = { fetchJobs, fetchDetails, detailCost };
