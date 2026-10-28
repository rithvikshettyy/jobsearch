import { afterEach, describe, expect, it, vi } from 'vitest';
import { himalayas } from '../src/sources/himalayas';
import type { Company } from '../src/types';

function stubFetch(payload: unknown): ReturnType<typeof vi.fn> {
	const spy = vi.fn(async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }));
	vi.stubGlobal('fetch', spy);
	return spy;
}

const requestedUrl = (spy: ReturnType<typeof vi.fn>): URL => new URL(String(spy.mock.calls[0]?.[0]));

function company(board: string): Company {
	return { id: 1, name: 'Himalayas feed', source: 'himalayas', board, tier: 2 };
}

function row(over: Record<string, unknown>): Record<string, unknown> {
	return {
		title: 'AI Engineer',
		companyName: 'Acme',
		employmentType: 'Full Time',
		seniority: ['Mid-level'],
		locationRestrictions: ['India'],
		description: '<p>Build <b>LLM</b> apps. 0-2 years.</p>',
		pubDate: 1_792_198_336,
		guid: 'https://himalayas.app/companies/acme/jobs/ai-engineer',
		applicationLink: 'https://himalayas.app/companies/acme/jobs/ai-engineer?utm_source=api',
		...over,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('himalayas', () => {
	it('builds the search url from the query and country', async () => {
		const spy = stubFetch({ jobs: [] });
		await himalayas.fetchJobs(company('ai engineer|in'));

		const url = requestedUrl(spy);
		expect(url.origin + url.pathname).toBe('https://himalayas.app/jobs/api/search');
		expect(url.searchParams.get('q')).toBe('ai engineer');
		expect(url.searchParams.get('country')).toBe('IN');
		expect(url.searchParams.get('sort')).toBe('recent');
	});

	it('maps WORLDWIDE to the worldwide flag and omits country when blank', async () => {
		let spy = stubFetch({ jobs: [] });
		await himalayas.fetchJobs(company('llm engineer|WORLDWIDE'));
		expect(requestedUrl(spy).searchParams.get('worldwide')).toBe('true');
		expect(requestedUrl(spy).searchParams.has('country')).toBe(false);

		spy = stubFetch({ jobs: [] });
		await himalayas.fetchJobs(company('llm engineer'));
		expect(requestedUrl(spy).searchParams.has('country')).toBe(false);
		expect(requestedUrl(spy).searchParams.has('worldwide')).toBe(false);
	});

	it('rejects a board with no query', async () => {
		stubFetch({ jobs: [] });
		await expect(himalayas.fetchJobs(company('|IN'))).rejects.toThrow(/no query/);
	});

	it('maps a row to the light job shape with a clean url and ISO date', async () => {
		stubFetch({ jobs: [row({})] });
		const [job] = await himalayas.fetchJobs(company('ai engineer|IN'));

		expect(job).toEqual({
			externalId: 'https://himalayas.app/companies/acme/jobs/ai-engineer',
			company: 'Acme',
			title: 'AI Engineer',
			location: 'Remote - India',
			url: 'https://himalayas.app/companies/acme/jobs/ai-engineer',
			postedAt: new Date(1_792_198_336 * 1000).toISOString(),
		});
		expect(job?.url).not.toContain('utm_');
	});

	it('says Worldwide when there is no country restriction', async () => {
		stubFetch({ jobs: [row({ locationRestrictions: [] })] });
		const [job] = await himalayas.fetchJobs(company('ai engineer'));
		expect(job?.location).toBe('Remote - Worldwide');
	});

	it('keeps full time and intern, drops contract, part time and temporary', async () => {
		stubFetch({
			jobs: [
				row({ guid: 'ft', employmentType: 'Full Time' }),
				row({ guid: 'in', employmentType: 'Intern' }),
				row({ guid: 'un', employmentType: '' }),
				row({ guid: 'ct', employmentType: 'Contractor' }),
				row({ guid: 'pt', employmentType: 'Part Time' }),
				row({ guid: 'tm', employmentType: 'Temporary' }),
			],
		});
		const jobs = await himalayas.fetchJobs(company('ai engineer'));
		expect(jobs.map((job) => job.externalId)).toEqual(['ft', 'in', 'un']);
	});

	it('drops a posting tagged only senior-level, keeps mixed and untagged ones', async () => {
		stubFetch({
			jobs: [
				row({ guid: 'senior', seniority: ['Senior'] }),
				row({ guid: 'mgr', seniority: ['Senior', 'Manager'] }),
				row({ guid: 'mixed', seniority: ['Entry-level', 'Senior'] }),
				row({ guid: 'none', seniority: [] }),
			],
		});
		const jobs = await himalayas.fetchJobs(company('ai engineer'));
		expect(jobs.map((job) => job.externalId)).toEqual(['mixed', 'none']);
	});

	it('refetches once for descriptions and strips the html', async () => {
		const spy = stubFetch({ jobs: [row({})] });
		const [job] = await himalayas.fetchJobs(company('ai engineer|IN'));
		spy.mockClear();

		const [detail] = await himalayas.fetchDetails(company('ai engineer|IN'), job ? [job] : []);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(detail?.description).toBe('Build LLM apps. 0-2 years.');
		expect(himalayas.detailCost(7)).toBe(1);
		expect(himalayas.detailCost(0)).toBe(0);
	});
});
