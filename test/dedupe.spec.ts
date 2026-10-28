import { describe, expect, it } from 'vitest';
import { collapseByFuzzy, dedupeKey, fuzzyKey, mergeLocations, normalizeTitle } from '../src/dedupe';

describe('normalizeTitle', () => {
	it('lowercases and collapses whitespace', () => {
		expect(normalizeTitle('  Software   Engineer ')).toBe('software engineer');
	});

	it('drops parenthetical and bracketed suffixes', () => {
		expect(normalizeTitle('Software Engineer (Remote) [US]')).toBe('software engineer');
	});

	it('drops req numbers and roman numeral levels', () => {
		expect(normalizeTitle('Backend Engineer II REQ-1234')).toBe('backend engineer');
	});

	it('keeps meaningful punctuation in stack names', () => {
		expect(normalizeTitle('C++ / C# Engineer')).toBe('c++ c# engineer');
	});
});

describe('dedupeKey', () => {
	it('is a 64-char hex sha256', async () => {
		const key = await dedupeKey('Acme', 'Software Engineer', 'Bengaluru');
		expect(key).toMatch(/^[0-9a-f]{64}$/);
	});

	it('collapses titles that normalize to the same thing', async () => {
		const a = await dedupeKey('Acme', 'Software Engineer (Remote)', 'Bengaluru');
		const b = await dedupeKey('Acme', 'software engineer', 'Bengaluru');
		expect(a).toBe(b);
	});

	it('separates different companies', async () => {
		const a = await dedupeKey('Acme', 'Software Engineer', 'Bengaluru');
		const b = await dedupeKey('Globex', 'Software Engineer', 'Bengaluru');
		expect(a).not.toBe(b);
	});

	it('separates different locations', async () => {
		const a = await dedupeKey('Acme', 'Software Engineer', 'Bengaluru');
		const b = await dedupeKey('Acme', 'Software Engineer', 'Berlin');
		expect(a).not.toBe(b);
	});
});

describe('fuzzyKey', () => {
	it('ignores location and company casing', async () => {
		expect(await fuzzyKey('Datadog', 'Software Engineer')).toBe(await fuzzyKey(' datadog ', 'software engineer (Remote)'));
	});

	it('still separates different roles and companies', async () => {
		expect(await fuzzyKey('Datadog', 'Software Engineer')).not.toBe(await fuzzyKey('Datadog', 'Data Engineer'));
		expect(await fuzzyKey('Datadog', 'Software Engineer')).not.toBe(await fuzzyKey('Stripe', 'Software Engineer'));
	});
});

describe('mergeLocations', () => {
	it('unions case-insensitively in first-seen order', () => {
		expect(mergeLocations('Bengaluru, India', 'pune; bengaluru, india')).toBe('Bengaluru, India; pune');
	});
});

describe('collapseByFuzzy', () => {
	it('keeps the first of a same-role group and merges its locations', () => {
		const items = [
			{ fuzzy: 'a', job: { location: 'Bengaluru, India' } },
			{ fuzzy: 'b', job: { location: 'Pune' } },
			{ fuzzy: 'a', job: { location: 'Mumbai, India' } },
		];
		const { kept, merged } = collapseByFuzzy(items);
		expect(merged).toBe(1);
		expect(kept.map((item) => item.job.location)).toEqual(['Bengaluru, India; Mumbai, India', 'Pune']);
		// The input is not mutated.
		expect(items[0]?.job.location).toBe('Bengaluru, India');
	});
});
