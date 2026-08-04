import { asIsoDate, asString, getJson, isRecord, stripHtml } from '../http';
import type { Company, Env, Job, JobDetail, Source } from '../types';

const BASE = 'https://api.adzuna.com/v1/api/jobs';

/** Adzuna's own cap. Asking for more is silently clamped, so state it. */
const RESULTS_PER_PAGE = 50;

/**
 * Aggregator feed, so `board` is a selector rather than an employer slug:
 *
 *   country:what:where      e.g. "in:software engineer:bengaluru"
 *   country:what            e.g. "in:python developer"
 *
 * `country` is an Adzuna market code (in, us, gb, ...) and is the one required
 * part — it is a path segment, not a query param, so a bad value 404s rather
 * than returning an empty page.
 */
interface Selector {
	country: string;
	what: string;
	where: string;
}

function parseSelector(board: string): Selector {
	const [country = '', what = '', where = ''] = board.split(':');
	const market = country.trim().toLowerCase();
	if (market === '') throw new Error(`adzuna: board "${board}" has no country code (expected "in:software engineer")`);
	return { country: market, what: what.trim(), where: where.trim() };
}

function feedUrl(company: Company, env: Env): string {
	const { country, what, where } = parseSelector(company.board);

	const appId = env.ADZUNA_APP_ID ?? '';
	const appKey = env.ADZUNA_APP_KEY ?? '';
	// A missing key comes back as a 401 HTML page that fails JSON parsing with a
	// useless message, so fail here instead — this lands in `errors` readable.
	if (appId === '' || appKey === '') throw new Error('adzuna: ADZUNA_APP_ID / ADZUNA_APP_KEY are not set');

	const query = new URLSearchParams({
		app_id: appId,
		app_key: appKey,
		results_per_page: String(RESULTS_PER_PAGE),
		// Newest first. Without this Adzuna sorts by its own relevance score and
		// the freshest postings can sit off the first page entirely.
		sort_by: 'date',
		'content-type': 'application/json',
	});
	if (what !== '') query.set('what', what);
	if (where !== '') query.set('where', where);

	return `${BASE}/${encodeURIComponent(country)}/search/1?${query.toString()}`;
}

function readJobs(payload: unknown, board: string): Record<string, unknown>[] {
	if (!isRecord(payload) || !Array.isArray(payload.results)) {
		throw new Error(`adzuna: unexpected payload for feed "${board}"`);
	}
	return payload.results.filter(isRecord);
}

/** `company` and `location` are nested objects, both optional on a sparse row. */
function displayName(value: unknown, fallback: string): string {
	return isRecord(value) ? asString(value.display_name, fallback) : fallback;
}

function toJob(raw: Record<string, unknown>): Job | null {
	const externalId = asString(raw.id);
	if (externalId === '') return null;
	return {
		externalId,
		// The employer, never "Adzuna" — the dedupe key is company|title|location,
		// so naming the aggregator here would collapse unrelated jobs together.
		company: displayName(raw.company, 'Unknown'),
		location: displayName(raw.location, ''),
		title: asString(raw.title),
		// redirect_url is Adzuna's tracked link. Their terms require it; the raw
		// employer URL is not exposed on this endpoint anyway.
		url: asString(raw.redirect_url),
		postedAt: asIsoDate(raw.created),
	};
}

export async function fetchJobs(company: Company, env: Env): Promise<Job[]> {
	const rows = readJobs(await getJson(feedUrl(company, env), 20_000), company.board);
	const jobs: Job[] = [];
	for (const raw of rows) {
		const job = toJob(raw);
		if (job !== null) jobs.push(job);
	}
	return jobs;
}

/**
 * WARNING — Adzuna truncates `description` to roughly the first 200 characters
 * and appends an ellipsis. There is no full-JD endpoint on the free tier; the
 * whole text only exists behind `redirect_url`, which is an HTML page this
 * Worker cannot afford to parse inside the 10ms CPU budget.
 *
 * Consequence: `descriptionDeny` and the YoE parse in `filters.ts` see a
 * snippet, so they under-match on this source. Titles and locations are
 * complete, so the light gates behave normally — only the detail gates are
 * weaker here than on an ATS board.
 *
 * One refetch covers the whole batch, hence `detailCost` of 1.
 */
export async function fetchDetails(company: Company, jobs: Job[], env: Env): Promise<JobDetail[]> {
	if (jobs.length === 0) return [];
	const rows = readJobs(await getJson(feedUrl(company, env), 20_000), company.board);

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

export const adzuna: Source = { fetchJobs, fetchDetails, detailCost };
