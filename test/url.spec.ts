import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/url';

describe('normalizeUrl', () => {
	it('forces https, drops www, the fragment and the trailing slash', () => {
		expect(normalizeUrl('http://www.Example.com/jobs/123/#apply')).toBe('https://example.com/jobs/123');
	});

	it('strips tracking params and keeps the ones that pick the job', () => {
		expect(normalizeUrl('https://boards.greenhouse.io/acme/jobs/9?utm_source=x&gh_src=abc&gh_jid=77&ref=tw&lever-source[]=li')).toBe('https://boards.greenhouse.io/acme/jobs/9?gh_jid=77');
	});

	it('sorts the remaining params so order never matters', () => {
		expect(normalizeUrl('https://a.com/j?b=2&a=1')).toBe(normalizeUrl('https://a.com/j?a=1&b=2'));
	});

	it('keeps the case of the path', () => {
		expect(normalizeUrl('https://a.com/Jobs/AbC')).toBe('https://a.com/Jobs/AbC');
	});

	it('makes the same posting from two sources one key', () => {
		expect(normalizeUrl('https://jobs.lever.co/acme/uuid-1?lever-source=Twitter')).toBe(normalizeUrl('http://www.jobs.lever.co/acme/uuid-1/'));
	});

	it('rejects anything that is not an http(s) url', () => {
		for (const raw of ['', 'not a url', 'javascript:alert(1)', 'ftp://a.com/x', 'mailto:a@b.com']) {
			expect(normalizeUrl(raw), raw).toBeNull();
		}
	});
});

describe('normalizeUrl for LinkedIn postings', () => {
	it('reduces every spelling of one posting to its number', () => {
		const canonical = 'https://www.linkedin.com/jobs/view/4000000001';
		for (const raw of [
			'https://in.linkedin.com/jobs/view/ai-engineer-at-acme-4000000001?refId=abc&trackingId=xyz&position=3',
			'https://www.linkedin.com/jobs/view/4000000001/?trackingId=other&currentJobId=4000000001',
			'http://linkedin.com/jobs/view/4000000001',
			'https://uk.linkedin.com/jobs/view/senior-thing-4000000001/',
		]) {
			expect(normalizeUrl(raw), raw).toBe(canonical);
		}
	});

	it('leaves other LinkedIn pages and other sites alone', () => {
		expect(normalizeUrl('https://www.linkedin.com/company/acme?trk=public_jobs')).toBe('https://linkedin.com/company/acme');
		expect(normalizeUrl('https://notlinkedin.com/jobs/view/4000000001')).toBe('https://notlinkedin.com/jobs/view/4000000001');
		expect(normalizeUrl('https://www.linkedin.com/jobs/view/123')).toBe('https://linkedin.com/jobs/view/123');
	});
});
