import { afterEach, describe, expect, it, vi } from 'vitest';
import { adzuna } from '../src/sources/adzuna';
import { jsearch } from '../src/sources/jsearch';
import type { Company, Env } from '../src/types';

/**
 * Both modules are pure request-build + response-map around one `getJson`, so
 * the global fetch is stubbed and the URL it receives is the assertion. Nothing
 * here touches the network or D1.
 */
function stubFetch(payload: unknown): ReturnType<typeof vi.fn> {
	const spy = vi.fn(async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }));
	vi.stubGlobal('fetch', spy);
	return spy;
}

const requestedUrl = (spy: ReturnType<typeof vi.fn>): URL => new URL(String(spy.mock.calls[0]?.[0]));
const requestedHeaders = (spy: ReturnType<typeof vi.fn>): Record<string, string> =>
	(spy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;

function company(source: Company['source'], board: string): Company {
	return { id: 1, name: `${source} feed`, source, board, tier: 2 };
}

const ADZUNA_ENV = { ADZUNA_APP_ID: 'app-id', ADZUNA_APP_KEY: 'app-key' } as Env;
const JSEARCH_ENV = { RAPIDAPI_KEY: 'rapid-key' } as Env;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('adzuna', () => {
	const payload = {
		count: 1,
		results: [
			{
				id: '4321',
				title: 'Software Engineer',
				created: '2026-07-30T09:00:00Z',
				redirect_url: 'https://www.adzuna.in/land/ad/4321',
				description: 'Build things. Requires 2 years of experience…',
				company: { display_name: 'Acme Systems' },
				location: { display_name: 'Bengaluru, Karnataka', area: ['India', 'Karnataka'] },
			},
		],
	};

	it('builds a market-scoped search url from the board selector', async () => {
		const spy = stubFetch(payload);
		await adzuna.fetchJobs(company('adzuna', 'in:software engineer:bengaluru'), ADZUNA_ENV);

		const url = requestedUrl(spy);
		expect(url.pathname).toBe('/v1/api/jobs/in/search/1');
		expect(url.searchParams.get('what')).toBe('software engineer');
		expect(url.searchParams.get('where')).toBe('bengaluru');
		expect(url.searchParams.get('app_id')).toBe('app-id');
		expect(url.searchParams.get('app_key')).toBe('app-key');
		// Relevance order would leave fresh postings off page 1.
		expect(url.searchParams.get('sort_by')).toBe('date');
	});

	it('omits what/where when the selector only names a country', async () => {
		const spy = stubFetch(payload);
		await adzuna.fetchJobs(company('adzuna', 'in'), ADZUNA_ENV);

		const url = requestedUrl(spy);
		expect(url.searchParams.has('what')).toBe(false);
		expect(url.searchParams.has('where')).toBe(false);
	});

	it('maps the employer, not the aggregator, into `company`', async () => {
		stubFetch(payload);
		const [job] = await adzuna.fetchJobs(company('adzuna', 'in:software engineer:'), ADZUNA_ENV);

		expect(job).toEqual({
			externalId: '4321',
			company: 'Acme Systems',
			title: 'Software Engineer',
			location: 'Bengaluru, Karnataka',
			url: 'https://www.adzuna.in/land/ad/4321',
			postedAt: '2026-07-30T09:00:00.000Z',
		});
	});

	it('survives a row with no nested company or location object', async () => {
		stubFetch({ results: [{ id: '9', title: 'Backend Engineer' }] });
		const [job] = await adzuna.fetchJobs(company('adzuna', 'in'), ADZUNA_ENV);

		expect(job?.company).toBe('Unknown');
		expect(job?.location).toBe('');
	});

	it('drops a row with no id rather than emitting a blank external id', async () => {
		stubFetch({ results: [{ title: 'Ghost' }, { id: '7', title: 'Real' }] });
		const jobs = await adzuna.fetchJobs(company('adzuna', 'in'), ADZUNA_ENV);

		expect(jobs.map((job) => job.externalId)).toEqual(['7']);
	});

	it('throws a named error when the credentials are absent', async () => {
		stubFetch(payload);
		await expect(adzuna.fetchJobs(company('adzuna', 'in'), {} as Env)).rejects.toThrow(/ADZUNA_APP_ID/);
	});

	it('throws when the board selector has no country code', async () => {
		stubFetch(payload);
		await expect(adzuna.fetchJobs(company('adzuna', ''), ADZUNA_ENV)).rejects.toThrow(/no country code/);
	});

	it('rejects a payload that is not a results array', async () => {
		stubFetch({ error: 'nope' });
		await expect(adzuna.fetchJobs(company('adzuna', 'in'), ADZUNA_ENV)).rejects.toThrow(/unexpected payload/);
	});

	it('costs one subrequest for a whole detail batch, zero for none', () => {
		expect(adzuna.detailCost(0)).toBe(0);
		expect(adzuna.detailCost(30)).toBe(1);
	});
});

describe('jsearch', () => {
	const payload = {
		status: 'OK',
		data: [
			{
				job_id: 'abc123',
				job_title: 'Frontend Engineer',
				employer_name: 'Globex',
				job_publisher: 'Indeed',
				job_apply_link: 'https://globex.example/apply/abc123',
				job_city: 'Hyderabad',
				job_state: 'Telangana',
				job_country: 'IN',
				job_is_remote: false,
				job_posted_at_datetime_utc: '2026-07-28T12:00:00.000Z',
				job_description: '<p>React and TypeScript.</p>',
			},
		],
	};

	it('sends the key in a header and the selector in the query', async () => {
		const spy = stubFetch(payload);
		await jsearch.fetchJobs(company('jsearch', 'software engineer in India|in|week'), JSEARCH_ENV);

		const url = requestedUrl(spy);
		expect(url.searchParams.get('query')).toBe('software engineer in India');
		expect(url.searchParams.get('country')).toBe('in');
		expect(url.searchParams.get('date_posted')).toBe('week');
		// The key must never reach the query string — RapidAPI logs those.
		expect(url.searchParams.has('x-rapidapi-key')).toBe(false);
		expect(requestedHeaders(spy)['x-rapidapi-key']).toBe('rapid-key');
	});

	it('omits country and date_posted when the selector is a bare query', async () => {
		const spy = stubFetch(payload);
		await jsearch.fetchJobs(company('jsearch', 'react developer'), JSEARCH_ENV);

		const url = requestedUrl(spy);
		expect(url.searchParams.get('query')).toBe('react developer');
		expect(url.searchParams.has('country')).toBe(false);
		expect(url.searchParams.has('date_posted')).toBe(false);
	});

	it('uses the employer, not the publisher, so a cross-posted role dedupes', async () => {
		stubFetch(payload);
		const [job] = await jsearch.fetchJobs(company('jsearch', 'frontend|in'), JSEARCH_ENV);

		expect(job?.company).toBe('Globex');
		expect(job?.location).toBe('Hyderabad, Telangana, IN');
	});

	it('prefixes Remote so a remote row with no city still matches geoOk', async () => {
		stubFetch({ data: [{ ...payload.data[0], job_city: '', job_state: '', job_is_remote: true }] });
		const [job] = await jsearch.fetchJobs(company('jsearch', 'frontend|in'), JSEARCH_ENV);

		expect(job?.location).toBe('Remote, IN');
	});

	it('strips description html in the detail path only', async () => {
		stubFetch(payload);
		const jobs = await jsearch.fetchJobs(company('jsearch', 'frontend|in'), JSEARCH_ENV);
		expect(jobs[0]).not.toHaveProperty('description');

		stubFetch(payload);
		const [detail] = await jsearch.fetchDetails(company('jsearch', 'frontend|in'), jobs, JSEARCH_ENV);
		expect(detail?.description).toBe('React and TypeScript.');
	});

	it('leaves a detail description empty when the refetch no longer lists the id', async () => {
		stubFetch(payload);
		const jobs = await jsearch.fetchJobs(company('jsearch', 'frontend|in'), JSEARCH_ENV);

		stubFetch({ data: [] });
		const [detail] = await jsearch.fetchDetails(company('jsearch', 'frontend|in'), jobs, JSEARCH_ENV);
		expect(detail?.description).toBe('');
	});

	it('spends nothing when the detail batch is empty', async () => {
		const spy = stubFetch(payload);
		await expect(jsearch.fetchDetails(company('jsearch', 'frontend|in'), [], JSEARCH_ENV)).resolves.toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});

	it('throws a named error when the key is absent', async () => {
		stubFetch(payload);
		await expect(jsearch.fetchJobs(company('jsearch', 'frontend|in'), {} as Env)).rejects.toThrow(/RAPIDAPI_KEY/);
	});

	it('throws when the board selector has no query', async () => {
		stubFetch(payload);
		await expect(jsearch.fetchJobs(company('jsearch', '|in'), JSEARCH_ENV)).rejects.toThrow(/no query/);
	});
});
