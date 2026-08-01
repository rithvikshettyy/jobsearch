import { describe, expect, it } from 'vitest';
import { dedupeKey, normalizeTitle } from '../src/dedupe';

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
