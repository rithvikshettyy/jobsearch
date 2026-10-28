import { describe, expect, it } from 'vitest';
import { isFresh, isRemote, matchesLocation, matchesTitle, passesDetailFilters, passesLightFilters, type FilterConfig } from '../src/filters';
import type { Job, JobDetail } from '../src/types';

const config: FilterConfig = {
	titleAllow: ['software engineer', 'backend'],
	titleDeny: ['senior', 'intern'],
	locationAllow: ['bengaluru', 'india'],
	allowRemote: true,
	maxAgeDays: 30,
	descriptionAllow: [],
	descriptionDeny: ['security clearance'],
};

const NOW = Date.parse('2026-08-01T00:00:00.000Z');

function job(overrides: Partial<Job> = {}): Job {
	return {
		externalId: '1',
		company: 'Acme',
		title: 'Software Engineer',
		location: 'Bengaluru, India',
		url: 'https://example.com/1',
		postedAt: '2026-07-25T00:00:00.000Z',
		...overrides,
	};
}

describe('matchesTitle', () => {
	it('accepts an allowed title', () => {
		expect(matchesTitle('Software Engineer', config)).toBe(true);
	});

	it('is case insensitive', () => {
		expect(matchesTitle('BACKEND ENGINEER', config)).toBe(true);
	});

	it('lets deny win over allow', () => {
		expect(matchesTitle('Senior Software Engineer', config)).toBe(false);
	});

	it('rejects a title matching nothing in the allow list', () => {
		expect(matchesTitle('Account Executive', config)).toBe(false);
	});

	it('allows everything when the allow list is empty', () => {
		expect(matchesTitle('Account Executive', { ...config, titleAllow: [] })).toBe(true);
	});
});

describe('matchesLocation', () => {
	it('accepts an allowed location', () => {
		expect(matchesLocation('Bengaluru, India', config)).toBe(true);
	});

	it('accepts remote when allowRemote is on', () => {
		expect(matchesLocation('Remote - APAC', config)).toBe(true);
		expect(matchesLocation('Remote - EMEA', config)).toBe(false);
	});

	it('rejects remote when allowRemote is off', () => {
		expect(matchesLocation('Remote - EMEA', { ...config, allowRemote: false })).toBe(false);
	});

	it('rejects an unlisted location', () => {
		expect(matchesLocation('Berlin, Germany', config)).toBe(false);
	});
});

describe('isRemote', () => {
	it.each(['Remote', 'Work from home', 'Anywhere'])('detects %s', (location) => {
		expect(isRemote(location)).toBe(true);
	});

	it('does not treat an office location as remote', () => {
		expect(isRemote('Bengaluru, India')).toBe(false);
	});
});

describe('isFresh', () => {
	it('accepts a recent posting', () => {
		expect(isFresh('2026-07-25T00:00:00.000Z', config, NOW)).toBe(true);
	});

	it('rejects a stale posting', () => {
		expect(isFresh('2026-05-01T00:00:00.000Z', config, NOW)).toBe(false);
	});

	it('keeps a posting with no date', () => {
		expect(isFresh(null, config, NOW)).toBe(true);
	});

	it('keeps a posting with an unparseable date', () => {
		expect(isFresh('not-a-date', config, NOW)).toBe(true);
	});

	it('skips the age check when maxAgeDays is 0', () => {
		expect(isFresh('2020-01-01T00:00:00.000Z', { ...config, maxAgeDays: 0 }, NOW)).toBe(true);
	});
});

describe('passesLightFilters', () => {
	it('passes a matching job', () => {
		expect(passesLightFilters(job(), config, NOW)).toBe(true);
	});

	it('fails on title', () => {
		expect(passesLightFilters(job({ title: 'Senior Backend Engineer' }), config, NOW)).toBe(false);
	});

	it('fails on location', () => {
		expect(passesLightFilters(job({ location: 'Berlin, Germany' }), config, NOW)).toBe(false);
	});

	it('fails on age', () => {
		expect(passesLightFilters(job({ postedAt: '2026-01-01T00:00:00.000Z' }), config, NOW)).toBe(false);
	});
});

describe('passesDetailFilters', () => {
	const detail = (description: string): JobDetail => ({ ...job(), description });

	it('rejects a denied phrase', () => {
		expect(passesDetailFilters(detail('Requires an active security clearance.'), config)).toBe(false);
	});

	it('accepts otherwise', () => {
		expect(passesDetailFilters(detail('You will build APIs.'), config)).toBe(true);
	});

	it('enforces descriptionAllow when set', () => {
		const strict = { ...config, descriptionAllow: ['typescript'] };
		expect(passesDetailFilters(detail('You will write Go.'), strict)).toBe(false);
		expect(passesDetailFilters(detail('You will write TypeScript.'), strict)).toBe(true);
	});
});
