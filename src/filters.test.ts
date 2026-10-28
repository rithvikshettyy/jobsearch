import { describe, expect, it } from 'vitest';
import { eligibleLocations, geoOk, isInternTitle, mentionsPpo, minYoe, roleOk, splitLocations, titleBoost, yoeOk, yoeVerdict, type FilterConfig } from './filters';

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
		for (const title of ['Sr. Software Engineer', 'Engineering Manager', 'Head of Platform']) {
			expect(roleOk(title), title).toBe(false);
		}
	});

	it('hard-excludes staff, whatever the allowlist says', () => {
		expect(roleOk('Staff Engineer')).toBe(false);
		expect(roleOk('Staff Software Engineer', config)).toBe(false);
		expect(roleOk('Staff Software Engineer - Frontend', config)).toBe(false);
	});

	it('hard-excludes every level marker, case-insensitively', () => {
		for (const title of [
			'SENIOR Backend Engineer',
			'Sr Backend Engineer',
			'Sr. Backend Engineer',
			'Principal Software Engineer',
			'Tech Lead, Backend',
			'Engineering Manager',
			'Director of Engineering',
			'Head of Engineering',
			'Solutions Architect',
			'Software Engineer II',
			'Software Engineer III',
			'Software Engineer IV',
			'Software Engineer L4',
			'Software Engineer L5',
			'SDE 2',
			'SDE2',
			'SDE-3',
			'Software Engineer 3 - Enterprise Architecture',
			'Engineer 4',
			'Intermediate Backend Engineer, India',
		]) {
			expect(roleOk(title), title).toBe(false);
			expect(roleOk(title, config), title).toBe(false);
		}
	});

	it('uses word boundaries, so near-misses survive', () => {
		for (const title of ['Backend Engineer, SRE Tooling', 'Software Engineer I', 'Leadership Program Graduate Engineer', 'Headless CMS Developer', 'Engineer 20 Series Support', 'Engineer, Platform']) {
			expect(roleOk(title), title).toBe(true);
		}
	});

	it('does not let an L1 band waive a strict level marker', () => {
		expect(roleOk('Software Engineer II L1')).toBe(false);
		expect(roleOk('Staff Engineer L1')).toBe(false);
	});

	it('now accepts interns, they are on the include list', () => {
		expect(roleOk('Backend Intern')).toBe(true);
		expect(roleOk('Software Engineering Intern', config)).toBe(true);
	});

	it('boosts an entry-level title past the allowlist, but only for technical roles', () => {
		expect(roleOk('Graduate Engineer Trainee', config)).toBe(true);
		expect(roleOk('Associate Developer', config)).toBe(true);
		expect(roleOk('Industrial Trainee - Controllership', config)).toBe(false);
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

	it('lets an explicit L1 band outrank the seniority denylist', () => {
		expect(roleOk('Technical Lead L1')).toBe(true);
		expect(roleOk('Software Engineer L1', config)).toBe(true);
		expect(roleOk('Developer Level 1')).toBe(true);
	});

	it('still requires the allowlist for an L1 title', () => {
		// The override bypasses the denylists, never the allowlist.
		expect(roleOk('Customer Support L1', config)).toBe(false);
	});

	it('keeps rejecting an unbanded lead title', () => {
		expect(roleOk('Technical Lead')).toBe(false);
		expect(roleOk('Lead Backend Engineer', config)).toBe(false);
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

	it('rejects a bare Remote unless allowBareRemote is on', () => {
		expect(geoOk('Remote')).toBe(true);
		expect(geoOk('Remote', geoConfig)).toBe(false);
		expect(geoOk('Remote', { ...geoConfig, allowBareRemote: true })).toBe(true);
		expect(geoOk('Remote - Portugal', { ...geoConfig, allowBareRemote: true })).toBe(false);
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

	it('keeps remote that names India, APAC, worldwide or anywhere', () => {
		for (const location of ['Anywhere', 'Worldwide, Remote', 'Remote - India', 'Remote - APAC', 'Bengaluru, India (Remote)']) {
			expect(geoOk(location, geoConfig), location).toBe(true);
		}
	});

	it('does not apply the region rule to a description', () => {
		// A JD mentioning other offices in passing is not a geo restriction.
		expect(geoOk('We have offices in Germany and Singapore. This role is remote.')).toBe(true);
	});
});

describe('multi-location postings', () => {
	const india = {
		locationAllow: ['india', 'bengaluru', 'bangalore', 'mumbai', 'pune', 'delhi', 'ncr', 'gurugram', 'noida', 'thane', 'navi mumbai'],
		allowRemote: true,
	};

	it('splits on ; | and newlines but not on commas', () => {
		expect(splitLocations('Bengaluru, India; Lisbon, Portugal')).toEqual(['Bengaluru, India', 'Lisbon, Portugal']);
		expect(splitLocations('Pune | Remote - APAC')).toEqual(['Pune', 'Remote - APAC']);
	});

	it('passes on any one eligible place and keeps only that one', () => {
		expect(eligibleLocations('Paris, France; Bengaluru, India; Remote, Portugal', india)).toEqual(['Bengaluru, India']);
	});

	it('rejects a list with no eligible place', () => {
		expect(geoOk('Portugal, Remote; France, Remote; Germany, Remote', india)).toBe(false);
		expect(geoOk('US-Remote, Chicago', india)).toBe(false);
		expect(geoOk('Chicago, Illinois, USA', india)).toBe(false);
	});

	it('matches whole tokens, so Indiana is not India', () => {
		expect(geoOk('Indianapolis, Indiana, USA', india)).toBe(false);
		expect(geoOk('Pune', india)).toBe(true);
		expect(geoOk('Delhi NCR', india)).toBe(true);
		expect(geoOk('Navi Mumbai, Maharashtra', india)).toBe(true);
	});

	it('still rejects a work-authorization clause across the whole string', () => {
		expect(eligibleLocations('Bengaluru, India (must be a US citizen)', india)).toEqual([]);
	});
});

describe('titleBoost', () => {
	it('reads entry-level titles', () => {
		for (const title of [
			'Software Engineering Intern',
			'Fresher - Backend',
			'New Grad Engineer',
			'Junior Developer',
			'Jr. SDE',
			'SDE 1',
			'Software Engineer I',
			'Associate Engineer',
			'Graduate Trainee',
		]) {
			expect(titleBoost(title), title).toBe(true);
		}
	});

	it('does not boost a plain or senior title', () => {
		for (const title of ['Software Engineer', 'Software Engineer II', 'Staff Engineer']) {
			expect(titleBoost(title), title).toBe(false);
		}
	});
});

describe('yoeVerdict', () => {
	it('separates unknown from rejected', () => {
		expect(yoeVerdict('0-1 years')).toBe('ok');
		expect(yoeVerdict('5+ years')).toBe('reject');
		expect(yoeVerdict('Great team, great snacks.')).toBe('unknown');
	});
});

describe('role search: FDE, AI, ML, LLM engineer', () => {
	const search = {
		titleAllow: ['forward deployed', 'fde', 'ai engineer', 'ai ml engineer', 'ml engineer', 'machine learning engineer', 'software engineer ml', 'llm engineer'],
		titleDeny: ['senior', 'lead', 'manager'],
		entryBoostAllow: false,
	};

	it('accepts the four roles and their common spellings', () => {
		for (const title of ['Forward Deployed Engineer', 'Forward Deployed AI Engineer', 'FDE, AI', 'AI Engineer', 'Applied AI Engineer', 'AI/ML Engineer', 'ML Engineer', 'Machine Learning Engineer', 'Software Engineer, ML', 'LLM Engineer']) {
			expect(roleOk(title, search), title).toBe(true);
		}
	});

	it('rejects other engineering roles, and entry wording no longer rescues them', () => {
		for (const title of ['Backend Engineer', 'Software Engineering Intern', 'Associate Developer', 'Graduate Engineer Trainee', 'Data Analyst']) {
			expect(roleOk(title, search), title).toBe(false);
		}
	});

	it('still hard-excludes senior levels', () => {
		expect(roleOk('Senior AI Engineer', search)).toBe(false);
		expect(roleOk('Staff ML Engineer', search)).toBe(false);
		expect(roleOk('AI Engineer II', search)).toBe(false);
	});

	it('keeps the entry boost when the flag is not set', () => {
		expect(roleOk('Associate Developer', { titleAllow: ['ml engineer'], titleDeny: [] })).toBe(true);
	});
});

describe('allowInternational', () => {
	const open = { locationAllow: ['india'], allowRemote: true, allowBareRemote: true, allowInternational: true };

	it('accepts any country, remote or on-site', () => {
		for (const place of ['Berlin, Germany', 'Remote - Portugal', 'Remote', 'Singapore', 'Toronto, Canada']) {
			expect(geoOk(place, open), place).toBe(true);
		}
	});

	it('still rejects US-only clauses and work-authorization clauses', () => {
		expect(geoOk('Remote (US only)', open)).toBe(false);
		expect(geoOk('Berlin, Germany (must be a US citizen)', open)).toBe(false);
	});

	it('drops only the US-only place of a multi-place posting', () => {
		expect(eligibleLocations('Bengaluru, India; Remote (US only)', open)).toEqual(['Bengaluru, India']);
	});

	it('is off by default', () => {
		expect(geoOk('Berlin, Germany', { locationAllow: ['india'], allowRemote: true })).toBe(false);
	});
});

describe('intern and PPO detection', () => {
	it('reads internship titles but not Internal', () => {
		expect(isInternTitle('AI Engineer Intern')).toBe(true);
		expect(isInternTitle('Machine Learning Internship')).toBe(true);
		expect(isInternTitle('Internal Tools Engineer')).toBe(false);
		expect(isInternTitle('AI Engineer')).toBe(false);
	});

	it('finds PPO and conversion wording', () => {
		for (const text of ['6 month internship with PPO', 'Pre-placement offer for top performers', 'Possibility of full-time conversion', 'Interns may convert to full time', 'Strong performers get a return offer', 'convertible to a permanent role']) {
			expect(mentionsPpo(text), text).toBe(true);
		}
		expect(mentionsPpo('Unpaid 3 month internship, certificate provided')).toBe(false);
		expect(mentionsPpo('We will happen to offer snacks')).toBe(false);
	});
});

describe('work authorization wording', () => {
	it('rejects the spelled-out and negated forms that used to slip through', () => {
		for (const text of [
			'You must be authorized to work in the United States.',
			'Candidates must be legally authorised to work in the UK.',
			'We do not offer visa sponsorship.',
			'The company does not offer sponsorship for this role.',
			'Unfortunately we cannot sponsor work visas.',
			'Visa sponsorship is not available.',
			'You must have the right to work in the UK.',
			'Applicants must be eligible to work in Canada.',
			'This role is open to US persons only.',
			'No sponsorship will be provided.',
		]) {
			expect(geoOk(text), text).toBe(false);
		}
	});

	it('does not reject postings that welcome candidates or offer sponsorship', () => {
		for (const text of [
			'We offer visa sponsorship and relocation support.',
			'Open to candidates authorized to work in India.',
			'We sponsor visas for the right people.',
			'Remote, work from anywhere. Strong sponsorship of learning and growth.',
		]) {
			expect(geoOk(text), text).toBe(true);
		}
	});
});
