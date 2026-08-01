import { asIsoDate, asString, getJson, isRecord, stripHtml } from '../http';
import type { Company, Job, JobDetail, Source } from '../types';

const BASE = 'https://api.ashbyhq.com/posting-api/job-board';

function boardUrl(company: Company, withDescriptions: boolean): string {
	const url = `${BASE}/${encodeURIComponent(company.board)}`;
	return withDescriptions ? `${url}?includeCompensation=false` : url;
}

function toJob(raw: Record<string, unknown>, company: Company): Job | null {
	const externalId = asString(raw.id);
	if (externalId === '') return null;
	return {
		externalId,
		company: company.name,
		title: asString(raw.title),
		location: asString(raw.location),
		url: asString(raw.jobUrl),
		postedAt: asIsoDate(raw.publishedAt ?? raw.updatedAt),
	};
}

function readJobsArray(payload: unknown, board: string): Record<string, unknown>[] {
	if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
		throw new Error(`ashby: unexpected payload for board "${board}"`);
	}
	return payload.jobs.filter(isRecord);
}

/**
 * Ashby returns `descriptionHtml` inline on the board endpoint. We ignore that
 * field here — poll path never reads a JD.
 */
export async function fetchJobs(company: Company): Promise<Job[]> {
	const rows = readJobsArray(await getJson(boardUrl(company, false)), company.board);
	const jobs: Job[] = [];
	for (const raw of rows) {
		const job = toJob(raw, company);
		if (job) jobs.push(job);
	}
	return jobs;
}

/**
 * Ashby has no per-posting detail endpoint, so descriptions come from one more
 * board fetch — 1 subrequest for the whole batch, hence `detailCost` of 1.
 */
export async function fetchDetails(company: Company, jobs: Job[]): Promise<JobDetail[]> {
	if (jobs.length === 0) return [];
	const rows = readJobsArray(await getJson(boardUrl(company, true)), company.board);

	const byId = new Map<string, Record<string, unknown>>();
	for (const raw of rows) byId.set(asString(raw.id), raw);

	return jobs.map((job) => {
		const raw = byId.get(job.externalId);
		const html = raw ? asString(raw.descriptionHtml) : '';
		const plain = raw ? asString(raw.descriptionPlain) : '';
		return { ...job, description: plain !== '' ? plain : stripHtml(html) };
	});
}

export function detailCost(n: number): number {
	return n === 0 ? 0 : 1;
}

export const ashby: Source = { fetchJobs, fetchDetails, detailCost };
