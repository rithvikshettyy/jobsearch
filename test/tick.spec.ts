import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTick } from '../src/index';

/**
 * End-to-end tick against D1 with every outbound fetch stubbed: one Greenhouse
 * board that exercises each gate once, and a Telegram endpoint that records
 * what would have been sent.
 */
const NOW = new Date().toISOString();

const LIST = [
	{ id: 1, title: 'Staff AI Engineer', location: { name: 'Bengaluru, India' } },
	{ id: 2, title: 'AI Engineer', location: { name: 'Bengaluru, India; Remote (US only)' } },
	{ id: 3, title: 'AI Engineer', location: { name: 'Remote (US only)' } },
	{ id: 4, title: 'ML Engineer', location: { name: 'Mumbai, India' } },
	{ id: 5, title: 'AI Engineer', location: { name: 'Pune, India' } },
].map((job) => ({ ...job, absolute_url: `https://boards.greenhouse.io/acme/jobs/${job.id}`, updated_at: NOW }));

const DESCRIPTIONS: Record<string, string> = {
	'2': '<p>You will build services. 0-1 years of experience.</p>',
	'4': '<p>You will build services. Great team, no number anywhere.</p>',
	'5': '<p>You will build services. 0-1 years of experience.</p>',
};

let telegram: string[] = [];

beforeEach(async () => {
	telegram = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.startsWith('https://api.telegram.org/')) {
				telegram.push(String(JSON.parse(String(init?.body)).text));
				return Response.json({ ok: true });
			}
			const detail = /\/jobs\/(\d+)$/.exec(url);
			if (detail?.[1] !== undefined) return Response.json({ content: DESCRIPTIONS[detail[1]] ?? '' });
			if (url.endsWith('/boards/acme/jobs')) return Response.json({ jobs: LIST });
			return new Response('not found', { status: 404 });
		}),
	);

	await env.DB.batch([
		env.DB.prepare(`DELETE FROM jobs`),
		env.DB.prepare(`DELETE FROM seen_postings`),
		env.DB.prepare(`DELETE FROM source_runs`),
		env.DB.prepare(`UPDATE companies SET active = 0`),
		env.DB.prepare(`INSERT OR REPLACE INTO companies (name, source, board, active, tier) VALUES ('Acme', 'greenhouse', 'acme', 1, 2)`),
	]);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('runTick funnel', () => {
	it('counts each stage and sends one merged message without the US-only place', async () => {
		const result = await runTick({ ...env, TELEGRAM_BOT_TOKEN: 'test-token' });

		expect(result.errors).toBe(0);
		expect(result.funnel).toMatchObject({
			fetched: 5,
			newIds: 5,
			passedTitle: 4, // Staff dropped
			passedLocation: 3, // US-only remote dropped
			passedFresh: 3,
			detailed: 3,
			passedDescription: 3,
			passedYoe: 2, // job 4 names no YOE
			unknownYoeBlocked: 1,
			deduped: 1, // job 5 is job 2 in another city
			queued: 1,
		});

		// One job, both Indian places, nothing from the US-only remote place.
		expect(telegram).toHaveLength(1);
		expect(telegram[0]).toContain('Bengaluru, India; Pune, India');
		expect(telegram[0]).not.toContain('US only');
		expect(telegram[0]).not.toContain('Staff');
		expect(telegram[0]).not.toContain('❓');

		const jobs = await env.DB.prepare(`SELECT title, locations, notified FROM jobs`).all<{ title: string; locations: string; notified: number }>();
		expect(jobs.results).toEqual([{ title: 'AI Engineer', locations: 'Bengaluru, India; Pune, India', notified: 1 }]);
	});

	it('writes a closed tick row and a company row to source_runs', async () => {
		const result = await runTick({ ...env, TELEGRAM_BOT_TOKEN: 'test-token' });

		const rows = await env.DB.prepare(`SELECT kind, company, finished_at, fetched, queued, errors FROM source_runs WHERE run_id = ?1 ORDER BY kind`)
			.bind(result.runId)
			.all<{ kind: string; company: string | null; finished_at: string | null; fetched: number; queued: number; errors: number }>();

		expect(rows.results).toHaveLength(2);
		const company = rows.results.find((row) => row.kind === 'company');
		const tick = rows.results.find((row) => row.kind === 'tick');
		expect(company).toMatchObject({ company: 'Acme', fetched: 5, queued: 1, errors: 0 });
		expect(tick?.finished_at).not.toBeNull();
	});

	it('stamps last_polled_at so the next tick takes someone else', async () => {
		await runTick({ ...env, TELEGRAM_BOT_TOKEN: 'test-token' });
		const row = await env.DB.prepare(`SELECT last_polled_at FROM companies WHERE name = 'Acme'`).first<{ last_polled_at: string | null }>();
		expect(row?.last_polled_at).not.toBeNull();
	});

	it('sends the unknown-YOE job only when the flag is on AND the title reads entry-level', async () => {
		// "ML Engineer" has no entry-level wording, so the flag alone is not enough.
		const result = await runTick({ ...env, TELEGRAM_BOT_TOKEN: 'test-token', SEND_UNKNOWN_YOE: 'true' });
		expect(result.funnel.unknownYoeBlocked).toBe(1);
		expect(result.funnel.passedYoe).toBe(2);
	});

	it('does not poll twice: a second tick finds nothing new', async () => {
		await runTick({ ...env, TELEGRAM_BOT_TOKEN: 'test-token' });
		telegram = [];
		const second = await runTick({ ...env, TELEGRAM_BOT_TOKEN: 'test-token' });
		expect(second.funnel.newIds).toBe(0);
		expect(telegram).toHaveLength(0);

		// An idle poll costs one closed tick row and no company row: D1's free plan allows 100,000
		// row writes a day, and "nothing happened" is not worth 4 of them per board per tick.
		const rows = await env.DB.prepare(`SELECT kind, finished_at FROM source_runs WHERE run_id = ?1`).bind(second.runId).all<{ kind: string; finished_at: string | null }>();
		expect(rows.results.map((row) => row.kind)).toEqual(['tick']);
		expect(rows.results[0]?.finished_at).not.toBeNull();
	});
});
