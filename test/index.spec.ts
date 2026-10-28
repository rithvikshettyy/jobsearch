import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('http surface', () => {
	it('serves /health with D1 row counts', async () => {
		const response = await SELF.fetch('https://example.com/health');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			counts: {
				companies: expect.any(Number),
				seenPostings: expect.any(Number),
				jobs: expect.any(Number),
				pending: expect.any(Number),
				errors: expect.any(Number),
				stale6h: expect.any(Number),
				unfinishedTicks24h: expect.any(Number),
			},
		});
	});

	it('404s an unknown path', async () => {
		const response = await SELF.fetch('https://example.com/nope');
		expect(response.status).toBe(404);
	});

	it('404s GET /run, the tick is POST only', async () => {
		const response = await SELF.fetch('https://example.com/run');
		expect(response.status).toBe(404);
	});
});

describe('routing of the machine endpoints', () => {
	// The test worker has none of the secrets, so a routed endpoint answers 503 (closed), never 404.
	// A 404 here means the path or method is not wired in `fetch`.
	const routed: Array<[string, string]> = [
		['POST', '/ingest'],
		['POST', '/tg-webhook'],
		['GET', '/queue?status=approved'],
		['POST', '/jobs/12/status'],
		['GET', '/x/state'],
		['POST', '/x/state'],
		['POST', '/x/alert'],
	];

	for (const [method, path] of routed) {
		it(`${method} ${path} is wired and closed without its secret`, async () => {
			const response = await SELF.fetch(`https://example.com${path}`, { method, body: method === 'POST' ? '{}' : undefined });
			expect(response.status).toBe(503);
		});
	}

	it('does not route the wrong method or a malformed job id', async () => {
		expect((await SELF.fetch('https://example.com/ingest')).status).toBe(404);
		expect((await SELF.fetch('https://example.com/queue', { method: 'POST', body: '{}' })).status).toBe(404);
		expect((await SELF.fetch('https://example.com/jobs/abc/status', { method: 'POST', body: '{}' })).status).toBe(404);
		expect((await SELF.fetch('https://example.com/jobs/12/status')).status).toBe(404);
	});
});
