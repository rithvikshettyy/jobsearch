import { asIsoDate, asString, getJson, isRecord, stripHtml } from '../http';
import type { Company, Job, JobDetail, Source } from '../types';

const BASE = 'https://boards-api.greenhouse.io/v1/boards';

const listUrl = (slug: string) => `${BASE}/${encodeURIComponent(slug)}/jobs`;
const detailUrl = (slug: string, id: string) => `${BASE}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}`;

/** One entry of the light payload. Returns null when the row has no usable id. */
function toJob(raw: unknown, companyName: string): Job | null {
	if (!isRecord(raw)) return null;
	const externalId = asString(raw.id);
	if (externalId === '') return null;
	return {
		externalId,
		company: companyName,
		title: asString(raw.title),
		location: isRecord(raw.location) ? asString(raw.location.name) : '',
		url: asString(raw.absolute_url),
		postedAt: asIsoDate(raw.updated_at ?? raw.first_published),
	};
}

/** Light list. No `?content=true` — that flag is what makes this endpoint expensive. */
export async function fetchJobs(company: Company): Promise<Job[]> {
	const payload = await getJson(listUrl(company.board));
	if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
		throw new Error(`greenhouse: unexpected payload for board "${company.board}"`);
	}

	const jobs: Job[] = [];
	for (const raw of payload.jobs) {
		const job = toJob(raw, company.name);
		if (job !== null) jobs.push(job);
	}
	return jobs;
}

/** One subrequest per job — Greenhouse has no batch detail endpoint. */
export async function fetchDetails(company: Company, jobs: Job[]): Promise<JobDetail[]> {
	const details: JobDetail[] = [];
	for (const job of jobs) {
		const payload = await getJson(detailUrl(company.board, job.externalId));
		const content = isRecord(payload) ? asString(payload.content) : '';
		details.push({ ...job, description: stripHtml(content) });
	}
	return details;
}

export function detailCost(n: number): number {
	return n;
}

export const greenhouse: Source = { fetchJobs, fetchDetails, detailCost };

// ---------------------------------------------------------------------------
// Slug-keyed, non-throwing variants. Same endpoints, but keyed on the board slug
// instead of a `Company` row, and a failure yields empty rather than an
// exception — for callers that poll a board without a D1 row behind it.
// ---------------------------------------------------------------------------

/**
 * Where the swallowed failure goes. A silent `[]` is indistinguishable from a
 * board that genuinely has no openings, so pass this if you care which happened
 * — the module itself stays I/O-free and never touches D1.
 */
export type ErrorSink = (error: unknown) => void;

/**
 * Light list for a board slug. Returns [] for a non-200, a malformed payload,
 * a timeout, or a board with no openings — never throws.
 *
 * `company` on each Job is set to `slug`; there is no display name at this
 * layer. Fields beyond id/title/location come free from the same response.
 */
export async function fetchList(slug: string, onError?: ErrorSink): Promise<Job[]> {
	try {
		const payload = await getJson(listUrl(slug));
		if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
			onError?.(new Error(`greenhouse: unexpected payload for board "${slug}"`));
			return [];
		}

		const jobs: Job[] = [];
		for (const raw of payload.jobs) {
			const job = toJob(raw, slug);
			if (job !== null) jobs.push(job);
		}
		return jobs;
	} catch (error) {
		onError?.(error);
		return [];
	}
}

/**
 * Full JD for one posting. Null on a non-200, a malformed payload, or a timeout
 * — never throws. Null is the empty value here rather than [], since exactly one
 * job is ever requested.
 */
export async function fetchDetail(slug: string, id: string, onError?: ErrorSink): Promise<JobDetail | null> {
	try {
		const payload = await getJson(detailUrl(slug, id));
		const job = toJob(payload, slug);
		if (job === null) {
			onError?.(new Error(`greenhouse: unexpected payload for job "${id}" on board "${slug}"`));
			return null;
		}
		return { ...job, description: stripHtml(asString(isRecord(payload) ? payload.content : '')) };
	} catch (error) {
		onError?.(error);
		return null;
	}
}
