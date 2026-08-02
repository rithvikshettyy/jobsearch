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
				cursor: expect.any(Number),
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
