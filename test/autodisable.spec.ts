import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTick } from '../src/index';

/**
 * One active board, one tick at a time. `mode` decides how the board's list and detail
 * endpoints answer, so each test scripts a sequence of polls.
 */
type Mode = 'list404' | 'list500' | 'timeout' | 'ok' | 'detail404' | 'srEmpty';
let mode: Mode = 'list404';

const NOW = new Date().toISOString();

beforeEach(async () => {
	mode = 'list404';
	await env.DB.batch([
		env.DB.prepare(`DELETE FROM jobs`),
		env.DB.prepare(`DELETE FROM seen_postings`),
		env.DB.prepare(`DELETE FROM source_runs`),
		env.DB.prepare(`DELETE FROM errors`),
		env.DB.prepare(`UPDATE companies SET active = 0`),
		env.DB.prepare(`INSERT OR REPLACE INTO companies (name, source, board, active, tier, fail_count, consec_404) VALUES ('Gone Co', 'greenhouse', 'goneco', 1, 2, 0, 0)`),
	]);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.startsWith('https://api.telegram.org/')) return Response.json({ ok: true });
			if (url.includes('smartrecruiters')) return mode === 'srEmpty' ? Response.json({ offset: 0, limit: 100, totalFound: 0, content: [] }) : new Response('x', { status: 500 });
			if (/\/jobs\/\d+$/.test(url)) return mode === 'detail404' ? new Response('gone', { status: 404 }) : Response.json({ content: '<p>0-1 years of experience</p>' });
			if (url.endsWith('/boards/goneco/jobs')) {
				if (mode === 'list404') return new Response('not found', { status: 404 });
				if (mode === 'list500') return new Response('boom', { status: 500 });
				if (mode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
				return Response.json({ jobs: [{ id: 1, title: 'AI Engineer', location: { name: 'Pune, India' }, absolute_url: 'https://boards.greenhouse.io/goneco/jobs/1', updated_at: NOW }] });
			}
			return new Response('not found', { status: 404 });
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const tick = (): Promise<unknown> => runTick({ ...env, TELEGRAM_BOT_TOKEN: 'test-token' });

async function board(): Promise<{ active: number; consec_404: number; fail_count: number }> {
	const row = await env.DB.prepare(`SELECT active, consec_404, fail_count FROM companies WHERE name = 'Gone Co'`).first<{ active: number; consec_404: number; fail_count: number }>();
	if (row === null) throw new Error('company row missing');
	return row;
}

async function switchOffLog(): Promise<Array<{ company: string; message: string }>> {
	const { results } = await env.DB.prepare(`SELECT company, message FROM errors WHERE stage = 'auto-disable'`).all<{ company: string; message: string }>();
	return results;
}

describe('auto-disable after consecutive 404s', () => {
	it('counts each 404 and keeps the board on until the fifth', async () => {
		for (let poll = 1; poll <= 4; poll += 1) await tick();
		expect(await board()).toEqual({ active: 1, consec_404: 4, fail_count: 4 });
		expect(await switchOffLog()).toEqual([]);
	});

	it('switches the board off on the fifth in a row, and says so in errors', async () => {
		for (let poll = 1; poll <= 5; poll += 1) await tick();
		expect(await board()).toEqual({ active: 0, consec_404: 5, fail_count: 5 });

		const log = await switchOffLog();
		expect(log).toHaveLength(1);
		expect(log[0]?.company).toBe('Gone Co');
		expect(log[0]?.message).toBe('switched off after 5 consecutive 404s from greenhouse:goneco');
	});

	it('does not poll a switched-off board again', async () => {
		for (let poll = 1; poll <= 5; poll += 1) await tick();
		const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM source_runs WHERE kind = 'company'`).first<{ n: number }>();
		await tick();
		const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM source_runs WHERE kind = 'company'`).first<{ n: number }>();
		expect(after?.n).toBe(before?.n);
		expect(await switchOffLog()).toHaveLength(1);
	});

	it('a good poll in the middle resets the run', async () => {
		for (let poll = 1; poll <= 3; poll += 1) await tick();
		mode = 'ok';
		await tick();
		expect(await board()).toEqual({ active: 1, consec_404: 0, fail_count: 0 });

		mode = 'list404';
		for (let poll = 1; poll <= 4; poll += 1) await tick();
		expect((await board()).active).toBe(1);
	});

	it('another kind of failure ends the run of 404s, so "5 in a row" means 5 in a row', async () => {
		for (let poll = 1; poll <= 3; poll += 1) await tick();
		mode = 'list500';
		await tick();
		expect(await board()).toMatchObject({ consec_404: 0, fail_count: 4 });

		mode = 'timeout';
		await tick();
		expect(await board()).toMatchObject({ consec_404: 0, fail_count: 5, active: 1 });
	});

	it('a 404 on one job detail is not a dead board', async () => {
		mode = 'detail404';
		for (let poll = 1; poll <= 6; poll += 1) {
			// The list is fine, so the new job is seen once; clear it so every tick hits the detail request again.
			await env.DB.prepare(`DELETE FROM seen_postings`).run();
			await tick();
		}
		expect(await board()).toMatchObject({ active: 1, consec_404: 0 });
		expect((await board()).fail_count).toBeGreaterThan(0);
		expect(await switchOffLog()).toEqual([]);
	});

	it('also covers SmartRecruiters, whose unknown company answers 200 with an empty list', async () => {
		mode = 'srEmpty';
		await env.DB.prepare(`UPDATE companies SET source = 'smartrecruiters', board = 'ghost', consec_404 = 0, fail_count = 0, active = 1 WHERE name = 'Gone Co'`).run();
		for (let poll = 1; poll <= 5; poll += 1) await tick();
		expect(await board()).toMatchObject({ active: 0, consec_404: 5 });
		expect((await switchOffLog())[0]?.message).toBe('switched off after 5 consecutive 404s from smartrecruiters:ghost');
	});

	it('records the 404 as its own error kind in source_runs', async () => {
		await tick();
		const row = await env.DB.prepare(`SELECT error_kind FROM source_runs WHERE kind = 'company'`).first<{ error_kind: string }>();
		expect(row?.error_kind).toBe('not_found');
	});
});
