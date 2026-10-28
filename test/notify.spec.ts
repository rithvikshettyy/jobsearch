import { describe, expect, it } from 'vitest';
import { CALLBACK_PATTERN, formatLine, formatSingle, planMessages, type NotifyJob } from '../src/notify';

function job(id: number, over: Partial<NotifyJob['job']> = {}, extra: Partial<NotifyJob> = {}): NotifyJob {
	return {
		id,
		hash: `h${id}`,
		yoeMin: 1,
		job: { externalId: `e${id}`, company: `Co ${id}`, title: `AI Engineer ${id}`, location: 'Pune, India', url: `https://x.com/${id}`, postedAt: null, ...over },
		...extra,
	};
}

const jobs = (count: number): NotifyJob[] => Array.from({ length: count }, (_, index) => job(index + 1));
const EM_OR_EN_DASH = /[–—]/;

describe('planMessages', () => {
	it('sends up to 10 jobs one per message, each with its own Apply and Skip', () => {
		const plan = planMessages(jobs(3));
		expect(plan).toHaveLength(3);
		expect(plan[1]?.keyboard).toEqual([
			[
				{ text: '✅ Apply', callback_data: 'a:2' },
				{ text: '❌ Skip', callback_data: 's:2' },
			],
		]);
	});

	it('still sends 10 as singles and turns 11 into a digest', () => {
		expect(planMessages(jobs(10))).toHaveLength(10);

		const digest = planMessages(jobs(11));
		expect(digest.map((message) => message.entries.length)).toEqual([5, 5, 1]);
		expect(digest[0]?.keyboard).toHaveLength(5);
		expect(digest[0]?.keyboard[2]?.map((button) => button.text)).toEqual(['✅ Apply 3', '❌ Skip 3']);
	});

	it('keeps callback data inside Telegram limits and in the format the webhook parses', () => {
		const all = planMessages(jobs(11)).flatMap((message) => message.keyboard.flat());
		for (const button of all) {
			expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
			expect(CALLBACK_PATTERN.test(button.callback_data)).toBe(true);
		}
	});
});

describe('message text', () => {
	it('never contains an em dash or en dash', () => {
		const entries = [job(1), job(2, { location: 'Berlin, Germany; Remote - Worldwide' }, { sources: 'x,jobspy', tweetUrl: 'https://x.com/a/status/1' })];
		for (const plan of [planMessages(entries), planMessages(jobs(12))]) {
			for (const message of plan) expect(message.text).not.toMatch(EM_OR_EN_DASH);
		}
		expect(formatLine(job(1), 1)).not.toMatch(EM_OR_EN_DASH);
	});

	it('shows source and tweet lines on a single message', () => {
		const text = formatSingle(job(1, {}, { sources: 'x,jobspy', tweetUrl: 'https://x.com/a/status/1' }));
		expect(text).toContain('Source: x, jobspy');
		expect(text).toContain('<a href="https://x.com/a/status/1">Tweet</a>');
	});

	it('escapes html in titles and drops the link for a junk url', () => {
		const text = formatSingle(job(1, { title: 'AI <b>Engineer</b> & more', url: 'javascript:alert(1)' }));
		expect(text).toContain('AI &lt;b&gt;Engineer&lt;/b&gt; &amp; more');
		expect(text).not.toContain('href="javascript');
	});

	it('prefixes by experience: entry, unknown, above the bar', () => {
		expect(formatSingle(job(1, {}, { yoeMin: 0 }))).toMatch(/^✅/);
		expect(formatSingle(job(1, {}, { yoeMin: null }))).toMatch(/^❓/);
		expect(formatSingle(job(1, {}, { yoeMin: 2 }))).toMatch(/^🔸/);
	});
});
