import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/http';
import { smartrecruiters } from '../src/sources/smartrecruiters';
import type { Company } from '../src/types';

function stubFetch(responder: (url: URL) => unknown): ReturnType<typeof vi.fn> {
	const spy = vi.fn(async (input: string | URL | Request) => {
		const body = responder(new URL(String(input instanceof Request ? input.url : input)));
		return body instanceof Response ? body : Response.json(body);
	});
	vi.stubGlobal('fetch', spy);
	return spy;
}

const company: Company = { id: 1, name: 'ServiceNow', source: 'smartrecruiters', board: 'ServiceNow', tier: 2 };

const posting = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: '744000158214791',
	name: 'AI Engineer, Platform',
	company: { identifier: 'ServiceNow', name: 'ServiceNow' },
	releasedDate: '2026-10-28T07:05:33.211Z',
	location: { city: 'Hyderabad', region: 'Telangana', country: 'in', remote: false, fullLocation: 'Hyderabad, Telangana, India' },
	typeOfEmployment: { id: 'permanent', label: 'Full-time' },
	...over,
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('smartrecruiters', () => {
	it('lists one page of 100 with a single request and maps the light fields', async () => {
		const spy = stubFetch(() => ({ offset: 0, limit: 100, totalFound: 1, content: [posting()] }));
		const jobs = await smartrecruiters.fetchJobs(company, {} as never);

		expect(spy).toHaveBeenCalledTimes(1);
		const url = new URL(String(spy.mock.calls[0]?.[0]));
		expect(url.pathname).toBe('/v1/companies/ServiceNow/postings');
		expect(url.searchParams.get('limit')).toBe('100');

		expect(jobs).toEqual([
			{
				externalId: '744000158214791',
				company: 'ServiceNow',
				title: 'AI Engineer, Platform',
				location: 'Hyderabad, Telangana, India',
				url: 'https://jobs.smartrecruiters.com/ServiceNow/744000158214791-ai-engineer-platform',
				postedAt: '2026-10-28T07:05:33.211Z',
			},
		]);
	});

	it('falls back to city and country code, then Remote, for the location', async () => {
		stubFetch(() => ({
			content: [
				posting({ id: '1', location: { city: 'Pune', country: 'in' } }),
				posting({ id: '2', location: { remote: true } }),
				posting({ id: '3', location: {} }),
			],
		}));
		const jobs = await smartrecruiters.fetchJobs(company, {} as never);
		expect(jobs.map((job) => job.location)).toEqual(['Pune, IN', 'Remote', '']);
	});

	it('drops contract, temporary and part time postings, keeps full time and internships', async () => {
		stubFetch(() => ({
			content: [
				posting({ id: 'ft', typeOfEmployment: { id: 'permanent' } }),
				posting({ id: 'in', typeOfEmployment: { id: 'internship' } }),
				posting({ id: 'ct', typeOfEmployment: { id: 'contract' } }),
				posting({ id: 'tm', typeOfEmployment: { id: 'temporary' } }),
				posting({ id: 'pt', typeOfEmployment: { id: 'part_time' } }),
				posting({ id: 'un', typeOfEmployment: undefined }),
			],
		}));
		const jobs = await smartrecruiters.fetchJobs(company, {} as never);
		expect(jobs.map((job) => job.externalId)).toEqual(['ft', 'in', 'un']);
	});

	it('reports an empty first page as a 404, because an unknown company answers 200 with nothing', async () => {
		stubFetch(() => ({ offset: 0, limit: 100, totalFound: 0, content: [] }));
		await expect(smartrecruiters.fetchJobs(company, {} as never)).rejects.toMatchObject({ name: 'HttpError', status: 404 });
		await expect(smartrecruiters.fetchJobs(company, {} as never)).rejects.toBeInstanceOf(HttpError);
	});

	it('rejects a payload that is not a posting list', async () => {
		stubFetch(() => ({ unexpected: true }));
		await expect(smartrecruiters.fetchJobs(company, {} as never)).rejects.toThrow(/unexpected payload/);
	});

	it('fetches each description from the detail endpoint, joins the sections and strips the html', async () => {
		const spy = stubFetch(() => ({
			jobAd: {
				sections: {
					companyDescription: { title: 'Company', text: '<p>We build <b>software</b>.</p>' },
					jobDescription: { title: 'Job', text: '<ul><li>Ship models</li></ul>' },
					qualifications: { title: 'You', text: '<p>0-2 years of experience&nbsp;in ML.</p>' },
				},
			},
		}));
		const [detail] = await smartrecruiters.fetchDetails(company, [{ externalId: '744', company: 'ServiceNow', title: 'AI Engineer', location: 'Pune', url: 'https://x', postedAt: null }], {} as never);

		expect(new URL(String(spy.mock.calls[0]?.[0])).pathname).toBe('/v1/companies/ServiceNow/postings/744');
		expect(detail?.description).toBe('We build software . Ship models 0-2 years of experience in ML.');
		expect(smartrecruiters.detailCost(7)).toBe(7);
		expect(smartrecruiters.detailCost(0)).toBe(0);
	});

	it('gives an empty description, not a crash, for a detail with no job ad', async () => {
		stubFetch(() => ({ id: '744' }));
		const [detail] = await smartrecruiters.fetchDetails(company, [{ externalId: '744', company: 'ServiceNow', title: 't', location: '', url: 'https://x', postedAt: null }], {} as never);
		expect(detail?.description).toBe('');
	});
});
