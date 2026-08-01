import { asIsoDate, asString, getJson, isRecord, stripHtml } from '../http';
import type { Company, Job, JobDetail, Source } from '../types';

const BASE = 'https://api.lever.co/v0/postings';
// Lever ships every description inline, so a board list can be several MB and
// routinely blows the default timeout.
const LIST_TIMEOUT_MS = 20_000;

function toJob(raw: Record<string, unknown>, company: Company): Job | null {
	const externalId = asString(raw.id);
	if (externalId === '') return null;
	const categories = isRecord(raw.categories) ? raw.categories : {};
	return {
		externalId,
		company: company.name,
		title: asString(raw.text),
		location: asString(categories.location),
		url: asString(raw.hostedUrl),
		postedAt: asIsoDate(raw.createdAt),
	};
}

/**
 * Lever has no content-free list endpoint — the JSON always carries descriptions.
 * We deliberately read only id/text/location/url here and never touch
 * `description`/`descriptionPlain`, so the poll path stays free of JD parsing.
 */
export async function fetchJobs(company: Company): Promise<Job[]> {
	const payload = await getJson(`${BASE}/${encodeURIComponent(company.board)}?mode=json`, LIST_TIMEOUT_MS);
	if (!Array.isArray(payload)) {
		throw new Error(`lever: unexpected payload for board "${company.board}"`);
	}

	const jobs: Job[] = [];
	for (const raw of payload) {
		if (!isRecord(raw)) continue;
		const job = toJob(raw, company);
		if (job) jobs.push(job);
	}
	return jobs;
}

export async function fetchDetails(company: Company, jobs: Job[]): Promise<JobDetail[]> {
	const details: JobDetail[] = [];
	for (const job of jobs) {
		const payload = await getJson(`${BASE}/${encodeURIComponent(company.board)}/${encodeURIComponent(job.externalId)}`);
		if (!isRecord(payload)) {
			details.push({ ...job, description: '' });
			continue;
		}
		const plain = asString(payload.descriptionPlain);
		details.push({ ...job, description: plain !== '' ? plain : stripHtml(asString(payload.description)) });
	}
	return details;
}

export function detailCost(n: number): number {
	return n;
}

export const lever: Source = { fetchJobs, fetchDetails, detailCost };
