import { asIsoDate, asString, getJson, isRecord, stripHtml } from '../http';
import type { Company, Job, JobDetail, Source } from '../types';

const FEED = 'https://remoteok.com/api';

/**
 * Remote OK's API terms require linking back to the posting's URL on
 * remoteok.com. That is what `url` is built from below — do not swap it for the
 * employer's own apply link, or API access gets suspended.
 */
const POSTING_BASE = 'https://remoteok.com/remote-jobs';

/**
 * The first array entry is a legal/attribution notice, not a job. It has no
 * `id`, so `toJob` drops it — but the shape is worth naming, because a future
 * "why is entry zero missing" is otherwise a mystery.
 */
function readJobs(payload: unknown): Record<string, unknown>[] {
	if (!Array.isArray(payload)) throw new Error('remoteok: expected a top-level array');
	return payload.filter(isRecord);
}

function toJob(raw: Record<string, unknown>): Job | null {
	const externalId = asString(raw.id);
	const slug = asString(raw.slug);
	if (externalId === '' || slug === '') return null;
	return {
		externalId,
		company: asString(raw.company),
		title: asString(raw.position),
		// Often empty on this feed; "Remote" keeps `geoOk` meaningful rather than
		// letting a blank string match an empty allowlist.
		location: asString(raw.location, 'Remote'),
		url: `${POSTING_BASE}/${slug}`,
		postedAt: asIsoDate(raw.date ?? (typeof raw.epoch === 'number' ? raw.epoch * 1000 : null)),
	};
}

export async function fetchJobs(_company: Company): Promise<Job[]> {
	const jobs: Job[] = [];
	for (const raw of readJobs(await getJson(FEED, 20_000))) {
		const job = toJob(raw);
		if (job !== null) jobs.push(job);
	}
	return jobs;
}

/** Descriptions are inline on the same feed, so one refetch covers the batch. */
export async function fetchDetails(_company: Company, jobs: Job[]): Promise<JobDetail[]> {
	if (jobs.length === 0) return [];

	const byId = new Map<string, Record<string, unknown>>();
	for (const raw of readJobs(await getJson(FEED, 20_000))) byId.set(asString(raw.id), raw);

	return jobs.map((job) => {
		const raw = byId.get(job.externalId);
		return { ...job, description: raw ? stripHtml(asString(raw.description)) : '' };
	});
}

export function detailCost(n: number): number {
	return n === 0 ? 0 : 1;
}

export const remoteok: Source = { fetchJobs, fetchDetails, detailCost };
