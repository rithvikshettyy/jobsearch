import { beforeEach, describe, expect, it } from 'vitest';
import { canMove, handleJobStatus, handleQueue, moveJob } from '../src/queue';
import { insertJob, resetJobs, statusOf, TEST_ENV } from './helpers';

beforeEach(resetJobs);

const keyed = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { 'x-ingest-key': TEST_ENV.INGEST_KEY ?? '', 'content-type': 'application/json' } });

describe('transitions', () => {
	it('allows the happy path and nothing after applied', () => {
		expect(canMove('new', 'approved')).toBe(true);
		expect(canMove('approved', 'applying')).toBe(true);
		expect(canMove('applying', 'applied')).toBe(true);
		expect(canMove('applied', 'approved')).toBe(false);
		expect(canMove('new', 'applied')).toBe(false);
	});
});

describe('moveJob', () => {
	it('moves a new job to approved', async () => {
		const id = await insertJob();
		const moved = await moveJob(TEST_ENV, id, 'approved');
		expect(moved.ok).toBe(true);
		expect(await statusOf(id)).toBe('approved');
	});

	it('refuses a jump the table does not allow', async () => {
		const id = await insertJob();
		expect(await moveJob(TEST_ENV, id, 'applied')).toEqual({ ok: false, reason: 'conflict', from: 'new' });
		expect(await statusOf(id)).toBe('new');
	});

	it('reports a missing job', async () => {
		expect(await moveJob(TEST_ENV, 999_999, 'approved')).toEqual({ ok: false, reason: 'not_found' });
	});

	it('onlyFrom stops a stale button reopening a decided job', async () => {
		const id = await insertJob({ status: 'approved' });
		const moved = await moveJob(TEST_ENV, id, 'skipped', { onlyFrom: 'new' });
		expect(moved).toEqual({ ok: false, reason: 'conflict', from: 'approved' });
		expect(await statusOf(id)).toBe('approved');
	});

	it('keeps a failure reason, and clears it when the job is approved again', async () => {
		const id = await insertJob({ status: 'applying' });
		const failed = await moveJob(TEST_ENV, id, 'failed', { failReason: 'form needs a login' });
		expect(failed.ok && failed.job.failReason).toBe('form needs a login');

		const retried = await moveJob(TEST_ENV, id, 'approved');
		expect(retried.ok && retried.job.failReason).toBeNull();
	});

	it('two claims on one job cannot both win', async () => {
		const id = await insertJob({ status: 'approved' });
		const [a, b] = await Promise.all([moveJob(TEST_ENV, id, 'applying'), moveJob(TEST_ENV, id, 'applying')]);
		expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
	});
});

describe('GET /queue', () => {
	it('is closed without the key', async () => {
		const response = await handleQueue(new Request('https://x/queue'), TEST_ENV);
		expect(response.status).toBe(401);
	});

	it('is closed, not open, when INGEST_KEY is unset', async () => {
		const response = await handleQueue(new Request('https://x/queue', keyed()), { ...TEST_ENV, INGEST_KEY: undefined });
		expect(response.status).toBe(503);
	});

	it('lists approved jobs by default and only those', async () => {
		const approved = await insertJob({ title: 'ML Engineer', status: 'approved' });
		await insertJob({ title: 'LLM Engineer', status: 'new' });
		await insertJob({ title: 'AI Engineer', status: 'skipped' });

		const response = await handleQueue(new Request('https://x/queue?status=approved', keyed()), TEST_ENV);
		const body = (await response.json()) as { jobs: Array<{ id: number; title: string; status: string }> };
		expect(response.status).toBe(200);
		expect(body.jobs.map((job) => job.id)).toEqual([approved]);
		expect(body.jobs[0]?.status).toBe('approved');
	});

	it('honours limit and rejects an unknown status', async () => {
		await insertJob({ status: 'approved' });
		await insertJob({ status: 'approved' });
		const limited = await handleQueue(new Request('https://x/queue?limit=1', keyed()), TEST_ENV);
		expect(((await limited.json()) as { jobs: unknown[] }).jobs).toHaveLength(1);

		const bad = await handleQueue(new Request('https://x/queue?status=bogus', keyed()), TEST_ENV);
		expect(bad.status).toBe(400);
	});
});

describe('POST /jobs/:id/status', () => {
	it('moves a job and returns it', async () => {
		const id = await insertJob({ status: 'approved' });
		const response = await handleJobStatus(new Request('https://x/jobs/1/status', keyed({ method: 'POST', body: JSON.stringify({ status: 'applying' }) })), TEST_ENV, id);
		expect(response.status).toBe(200);
		expect(await statusOf(id)).toBe('applying');
	});

	it('answers 409 for a move the table forbids and 404 for an unknown id', async () => {
		const id = await insertJob({ status: 'new' });
		const conflict = await handleJobStatus(new Request('https://x', keyed({ method: 'POST', body: JSON.stringify({ status: 'applied' }) })), TEST_ENV, id);
		expect(conflict.status).toBe(409);

		const missing = await handleJobStatus(new Request('https://x', keyed({ method: 'POST', body: JSON.stringify({ status: 'approved' }) })), TEST_ENV, 999_999);
		expect(missing.status).toBe(404);
	});

	it('rejects a bad status, bad JSON, and a missing key', async () => {
		const id = await insertJob();
		expect((await handleJobStatus(new Request('https://x', keyed({ method: 'POST', body: JSON.stringify({ status: 'done' }) })), TEST_ENV, id)).status).toBe(400);
		expect((await handleJobStatus(new Request('https://x', keyed({ method: 'POST', body: 'not json' })), TEST_ENV, id)).status).toBe(400);
		expect((await handleJobStatus(new Request('https://x', { method: 'POST', body: '{}' }), TEST_ENV, id)).status).toBe(401);
	});
});
