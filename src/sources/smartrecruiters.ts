import { asIsoDate, asString, getJson, HttpError, isRecord, stripHtml } from '../http';
import type { Company, Job, JobDetail, Source } from '../types';

const BASE = 'https://api.smartrecruiters.com/v1/companies';

/** The API's own page cap. One page per poll: it lists newest first, so new postings are on it. */
const PAGE = 100;

const listUrl = (identifier: string) => `${BASE}/${encodeURIComponent(identifier)}/postings?limit=${PAGE}`;
const detailUrl = (identifier: string, id: string) => `${BASE}/${encodeURIComponent(identifier)}/postings/${encodeURIComponent(id)}`;

/**
 * Employment types that are not the search: full time, or an internship (the PPO check
 * runs on the JD). SmartRecruiters is the one ATS here that reports the type on the list.
 */
const UNWANTED_TYPES = new Set(['contract', 'temporary', 'part_time', 'parttime', 'volunteer']);

function wanted(raw: Record<string, unknown>): boolean {
	const type = isRecord(raw.typeOfEmployment) ? asString(raw.typeOfEmployment.id).toLowerCase() : '';
	return !UNWANTED_TYPES.has(type);
}

/** "Hyderabad, Telangana, India", or city and country code, or Remote when that is all there is. */
function locationOf(raw: Record<string, unknown>): string {
	const place = isRecord(raw.location) ? raw.location : {};
	const full = asString(place.fullLocation);
	if (full !== '') return full;
	const joined = [asString(place.city), asString(place.country).toUpperCase()].filter((part) => part !== '').join(', ');
	if (joined !== '') return joined;
	return place.remote === true ? 'Remote' : '';
}

const slugify = (name: string): string =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

function toJob(raw: unknown, company: Company): Job | null {
	if (!isRecord(raw) || !wanted(raw)) return null;
	const externalId = asString(raw.id);
	if (externalId === '') return null;

	const title = asString(raw.name);
	// The list carries no posting URL. The slug after the id is cosmetic, the id is what resolves.
	const identifier = isRecord(raw.company) ? asString(raw.company.identifier, company.board) : company.board;
	const slug = slugify(title);
	return {
		externalId,
		company: company.name,
		title,
		location: locationOf(raw),
		url: `https://jobs.smartrecruiters.com/${encodeURIComponent(identifier)}/${externalId}${slug === '' ? '' : `-${slug}`}`,
		postedAt: asIsoDate(raw.releasedDate),
	};
}

/**
 * One request, the newest 100 postings.
 *
 * An unknown company identifier does NOT 404 on this API: it answers 200 with an empty
 * list, which is indistinguishable from a board with nothing open. An empty first page is
 * therefore reported as a 404, so the same "5 in a row and the board is switched off" rule
 * that covers the other ATSs covers this one.
 */
export async function fetchJobs(company: Company): Promise<Job[]> {
	const url = listUrl(company.board);
	const payload = await getJson(url);
	if (!isRecord(payload) || !Array.isArray(payload.content)) {
		throw new Error(`smartrecruiters: unexpected payload for company "${company.board}"`);
	}
	if (payload.content.length === 0) throw new HttpError(404, url);

	const jobs: Job[] = [];
	for (const raw of payload.content) {
		const job = toJob(raw, company);
		if (job !== null) jobs.push(job);
	}
	return jobs;
}

/** One subrequest per job: the description is only on the detail endpoint. */
export async function fetchDetails(company: Company, jobs: Job[]): Promise<JobDetail[]> {
	const details: JobDetail[] = [];
	for (const job of jobs) {
		const payload = await getJson(detailUrl(company.board, job.externalId));
		const jobAd = isRecord(payload) && isRecord(payload.jobAd) ? payload.jobAd : {};
		const sections = isRecord(jobAd.sections) ? Object.values(jobAd.sections) : [];
		const html = sections.map((section) => (isRecord(section) ? asString(section.text) : '')).join(' ');
		details.push({ ...job, description: stripHtml(html) });
	}
	return details;
}

export function detailCost(n: number): number {
	return n;
}

export const smartrecruiters: Source = { fetchJobs, fetchDetails, detailCost };
