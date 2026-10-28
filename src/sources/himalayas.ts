import { asIsoDate, asString, getJson, isRecord, stripHtml } from '../http';
import type { Company, Job, JobDetail, Source } from '../types';

const BASE = 'https://himalayas.app/jobs/api/search';

/**
 * Role-search source: no employer is named, a query is. `board` is a selector
 *
 *   query|country        e.g. "ai engineer|IN"
 *   query|WORLDWIDE      jobs open to candidates anywhere
 *   query                everything the query matches, any country
 *
 * `country` is an ISO code. The query is fuzzy on Himalayas' side (a search for
 * "ai engineer" reports thousands of matches), so `roleOk` in the pipeline is
 * what actually decides which titles survive.
 */
interface Selector {
	query: string;
	country: string;
}

function parseSelector(board: string): Selector {
	const [query = '', country = ''] = board.split('|');
	const text = query.trim();
	if (text === '') throw new Error(`himalayas: board "${board}" has no query (expected "ai engineer|IN")`);
	return { query: text, country: country.trim().toUpperCase() };
}

function feedUrl(company: Company): string {
	const { query, country } = parseSelector(company.board);
	// sort=recent biases the 20-row page to fresh postings. Without it the page is
	// relevance-ranked and can be weeks old.
	const params = new URLSearchParams({ q: query, sort: 'recent' });
	if (country === 'WORLDWIDE') params.set('worldwide', 'true');
	else if (country !== '') params.set('country', country);
	return `${BASE}?${params.toString()}`;
}

function readJobs(payload: unknown, board: string): Record<string, unknown>[] {
	if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
		throw new Error(`himalayas: unexpected payload for query "${board}"`);
	}
	return payload.jobs.filter(isRecord);
}

/**
 * The search wants full time, or an internship (the PPO check happens on the JD).
 * Contract, part time, temporary and volunteer postings are dropped here because
 * this is the only place the type is known; an unlabelled row is kept.
 */
const WANTED_TYPES = new Set(['full time', 'intern', 'internship', '']);

/** A posting tagged only with these levels is not an entry-level req. */
const SENIOR_LEVELS = new Set(['senior', 'manager', 'director', 'executive', 'lead']);

function wanted(raw: Record<string, unknown>): boolean {
	if (!WANTED_TYPES.has(asString(raw.employmentType).trim().toLowerCase())) return false;
	const levels = Array.isArray(raw.seniority) ? raw.seniority.map((level) => asString(level).trim().toLowerCase()).filter((level) => level !== '') : [];
	return levels.length === 0 || !levels.every((level) => SENIOR_LEVELS.has(level));
}

/**
 * `locationRestrictions` lists the countries a candidate must live in; empty means
 * anywhere. It is written into the location as "Remote - ..." so the place check
 * and the Telegram message both say what the restriction is.
 */
function locationOf(raw: Record<string, unknown>): string {
	const places = Array.isArray(raw.locationRestrictions) ? raw.locationRestrictions.map((place) => asString(place)).filter((place) => place !== '') : [];
	return places.length === 0 ? 'Remote - Worldwide' : `Remote - ${places.join(', ')}`;
}

function toJob(raw: Record<string, unknown>): Job | null {
	// guid is the clean posting URL; applicationLink carries a utm_source tracking param.
	const guid = asString(raw.guid);
	if (guid === '') return null;
	return {
		externalId: guid,
		// The employer, not Himalayas, so the dedupe key stays company|title|location.
		company: asString(raw.companyName, 'Unknown'),
		title: asString(raw.title),
		location: locationOf(raw),
		url: guid,
		// pubDate is epoch SECONDS, asIsoDate takes millis.
		postedAt: typeof raw.pubDate === 'number' ? asIsoDate(raw.pubDate * 1000) : null,
	};
}

export async function fetchJobs(company: Company): Promise<Job[]> {
	const rows = readJobs(await getJson(feedUrl(company), 20_000), company.board);
	const jobs: Job[] = [];
	for (const raw of rows) {
		if (!wanted(raw)) continue;
		const job = toJob(raw);
		if (job !== null) jobs.push(job);
	}
	return jobs;
}

/**
 * Descriptions ship inline, but `fetchJobs` drops them so the poll path never
 * reads a JD. One refetch of the same page covers the batch: cost 1, like Remotive.
 */
export async function fetchDetails(company: Company, jobs: Job[]): Promise<JobDetail[]> {
	if (jobs.length === 0) return [];
	const rows = readJobs(await getJson(feedUrl(company), 20_000), company.board);

	const byGuid = new Map<string, Record<string, unknown>>();
	for (const raw of rows) byGuid.set(asString(raw.guid), raw);

	return jobs.map((job) => {
		const raw = byGuid.get(job.externalId);
		return { ...job, description: raw ? stripHtml(asString(raw.description)) : '' };
	});
}

export function detailCost(n: number): number {
	return n === 0 ? 0 : 1;
}

export const himalayas: Source = { fetchJobs, fetchDetails, detailCost };
