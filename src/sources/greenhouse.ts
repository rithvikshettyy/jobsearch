import { asIsoDate, asString, getJson, isRecord, stripHtml } from '../http';
import type { Company, Job, JobDetail, Source } from '../types';

const BASE = 'https://boards-api.greenhouse.io/v1/boards';

/** Light list. No `?content=true` — that flag is what makes this endpoint expensive. */
export async function fetchJobs(company: Company): Promise<Job[]> {
	const payload = await getJson(`${BASE}/${encodeURIComponent(company.board)}/jobs`);
	if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
		throw new Error(`greenhouse: unexpected payload for board "${company.board}"`);
	}

	const jobs: Job[] = [];
	for (const raw of payload.jobs) {
		if (!isRecord(raw)) continue;
		const externalId = asString(raw.id);
		if (externalId === '') continue;
		jobs.push({
			externalId,
			company: company.name,
			title: asString(raw.title),
			location: isRecord(raw.location) ? asString(raw.location.name) : '',
			url: asString(raw.absolute_url),
			postedAt: asIsoDate(raw.updated_at ?? raw.first_published),
		});
	}
	return jobs;
}

/** One subrequest per job — Greenhouse has no batch detail endpoint. */
export async function fetchDetails(company: Company, jobs: Job[]): Promise<JobDetail[]> {
	const details: JobDetail[] = [];
	for (const job of jobs) {
		const payload = await getJson(`${BASE}/${encodeURIComponent(company.board)}/jobs/${encodeURIComponent(job.externalId)}`);
		const content = isRecord(payload) ? asString(payload.content) : '';
		details.push({ ...job, description: stripHtml(content) });
	}
	return details;
}

export function detailCost(n: number): number {
	return n;
}

export const greenhouse: Source = { fetchJobs, fetchDetails, detailCost };
