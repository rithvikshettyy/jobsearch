import { describe, expect, it } from 'vitest';
import { geoOk, minYoe, roleOk, yoeOk, type FilterConfig } from './filters';

const config: Pick<FilterConfig, 'titleAllow' | 'titleDeny'> = {
	titleAllow: ['software engineer', 'backend', 'frontend'],
	titleDeny: ['sales', 'recruiter'],
};

const geoConfig: Pick<FilterConfig, 'locationAllow' | 'allowRemote'> = {
	locationAllow: ['bengaluru', 'india'],
	allowRemote: true,
};

describe('minYoe', () => {
	it('takes the low end of a range', () => {
		expect(minYoe('0-2 years')).toBe(0);
		expect(minYoe('1-3 years')).toBe(1);
	});

	it('reads a "+" floor', () => {
		expect(minYoe('2+ years')).toBe(2);
	});

	it('reads a worded minimum', () => {
		expect(minYoe('minimum 3 yrs')).toBe(3);
	});

	it('floors a sub-year ask to 0', () => {
		expect(minYoe('6 months')).toBe(0);
	});

	it('is null when experience is never mentioned', () => {
		expect(minYoe('We are hiring a Software Engineer to join the platform team.')).toBeNull();
	});

	it('does not double-count the tail of a range as its own floor', () => {
		// "0-2 years" must read as 0, not as a range plus a bare "2 years".
		expect(minYoe('0-2 years of industry experience')).toBe(0);
	});

	it('takes the highest floor across separate mentions', () => {
		expect(minYoe('5+ years of engineering, plus 1+ years with Python')).toBe(5);
	});

	it('accepts dash and word variants', () => {
		expect(minYoe('1 – 3 years')).toBe(1);
		expect(minYoe('1 to 3 years')).toBe(1);
		expect(minYoe('MINIMUM 3 YRS')).toBe(3);
	});

	it('ignores numbers with no time unit', () => {
		expect(minYoe('401k, 2026 start date, team of 12')).toBeNull();
	});

	it('converts months past a year', () => {
		expect(minYoe('18 months')).toBe(1);
	});
});

describe('yoeOk', () => {
	it('admits entry-level bands at the default cap of 2', () => {
		expect(yoeOk('0-2 years')).toBe(true);
		expect(yoeOk('2+ years')).toBe(true);
		expect(yoeOk('1-3 years')).toBe(true);
		expect(yoeOk('6 months')).toBe(true);
	});

	it('rejects a floor above the cap', () => {
		expect(yoeOk('minimum 3 yrs')).toBe(false);
	});

	it('passes an unstated requirement', () => {
		expect(yoeOk('No experience section at all.')).toBe(true);
	});

	it('honours a custom cap', () => {
		expect(yoeOk('minimum 3 yrs', 3)).toBe(true);
		expect(yoeOk('2+ years', 1)).toBe(false);
	});
});

describe('roleOk', () => {
	it('rejects a senior title even when the config would allow it', () => {
		expect(roleOk('Senior Frontend Engineer')).toBe(false);
		expect(roleOk('Senior Frontend Engineer', config)).toBe(false);
	});

	it('rejects the rest of the seniority ladder', () => {
		for (const title of ['Sr. Software Engineer', 'Engineering Manager', 'Head of Platform', 'Backend Intern']) {
			expect(roleOk(title), title).toBe(false);
		}
	});

	it('accepts a staff title — the search asks for it, and the YOE gate is what filters it', () => {
		expect(roleOk('Staff Engineer')).toBe(true);
		expect(roleOk('Staff Software Engineer', config)).toBe(true);
	});

	it('accepts an entry-level title', () => {
		expect(roleOk('Frontend Engineer')).toBe(true);
		expect(roleOk('Software Engineer, New Grad', config)).toBe(true);
	});

	it('applies the config allowlist only when one is given', () => {
		expect(roleOk('Data Scientist')).toBe(true);
		expect(roleOk('Data Scientist', config)).toBe(false);
		expect(roleOk('Sales Engineer', config)).toBe(false);
	});

	it('does not match a seniority word inside a longer word', () => {
		expect(roleOk('Disaster Recovery Engineer')).toBe(true);
	});
});

describe('geoOk', () => {
	it('accepts an in-scope location', () => {
		expect(geoOk('Bengaluru, India')).toBe(true);
		expect(geoOk('Bengaluru, India', geoConfig)).toBe(true);
	});

	it('rejects a US-only remote posting despite the word "remote"', () => {
		// The remote shortcut must not fire before the US-only check.
		expect(geoOk('Remote (US only)')).toBe(false);
		expect(geoOk('Remote (US only)', geoConfig)).toBe(false);
	});

	it('rejects a work-authorization requirement', () => {
		expect(geoOk('must be authorized to work in the US')).toBe(false);
		expect(geoOk('Applicants must be a US citizen.')).toBe(false);
		expect(geoOk('We are unable to sponsor visas for this role.')).toBe(false);
	});

	it('normalizes punctuation in the disqualifier', () => {
		expect(geoOk('Remote — U.S. only')).toBe(false);
		expect(geoOk('US-only role')).toBe(false);
	});

	it('accepts unrestricted remote', () => {
		expect(geoOk('Remote')).toBe(true);
		expect(geoOk('Remote', geoConfig)).toBe(true);
	});

	it('applies the location allowlist only when one is given', () => {
		expect(geoOk('Berlin, Germany')).toBe(true);
		expect(geoOk('Berlin, Germany', geoConfig)).toBe(false);
	});

	it('rejects remote that is tied to a region this search cannot serve', () => {
		// Real locations that used to pass on the bare word "remote".
		for (const location of [
			'US-Remote, Chicago, Seattle, San Francisco',
			'Portugal, Remote',
			'France, Remote; Germany, Remote; Ireland, Remote',
			'Remote - California',
			'Remote (US/Canada)',
		]) {
			expect(geoOk(location, geoConfig), location).toBe(false);
		}
	});

	it('keeps remote when it is unqualified or names an in-scope location', () => {
		for (const location of ['Remote', 'Anywhere', 'Worldwide, Remote', 'Remote - India', 'Bengaluru, India (Remote)']) {
			expect(geoOk(location, geoConfig), location).toBe(true);
		}
	});

	it('does not apply the region rule to a description', () => {
		// A JD mentioning other offices in passing is not a geo restriction.
		expect(geoOk('We have offices in Germany and Singapore. This role is remote.')).toBe(true);
	});
});
