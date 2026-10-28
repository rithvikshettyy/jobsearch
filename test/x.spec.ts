import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleXAlert, handleXState, handleXStateWrite } from '../src/x';
import { stubTelegram, TEST_ENV, type BotCall } from './helpers';

let calls: BotCall[];

beforeEach(async () => {
	await env.DB.prepare(`DELETE FROM meta WHERE key LIKE 'x\\_%' ESCAPE '\\'`).run();
	calls = stubTelegram();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const keyed = (body?: unknown): RequestInit => ({
	method: body === undefined ? 'GET' : 'POST',
	headers: { 'x-ingest-key': TEST_ENV.INGEST_KEY ?? '', 'content-type': 'application/json' },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function state(): Promise<{ last_run_at: string | null; last_alert_at: string | null; accounts: Record<string, string> }> {
	return (await (await handleXState(new Request('https://x/x/state', keyed()), TEST_ENV)).json()) as never;
}

describe('x state endpoints', () => {
	it('are closed without the key and closed when the secret is unset', async () => {
		expect((await handleXState(new Request('https://x/x/state'), TEST_ENV)).status).toBe(401);
		expect((await handleXStateWrite(new Request('https://x/x/state', { method: 'POST', body: '{}' }), TEST_ENV)).status).toBe(401);
		expect((await handleXAlert(new Request('https://x/x/alert', { method: 'POST', body: '{}' }), TEST_ENV)).status).toBe(401);
		expect((await handleXState(new Request('https://x/x/state', keyed()), { ...TEST_ENV, INGEST_KEY: undefined })).status).toBe(503);
	});

	it('starts empty and stores a cursor per account', async () => {
		expect(await state()).toEqual({ last_run_at: null, last_alert_at: null, accounts: {} });

		const written = await handleXStateWrite(new Request('https://x', keyed({ accounts: { RohoolAgi: '1850000000000000001', Ajay_2512x: '1850000000000000009' }, run_at: '2026-10-28T10:00:00Z' })), TEST_ENV);
		expect(written.status).toBe(200);
		expect(await state()).toEqual({
			last_run_at: '2026-10-28T10:00:00.000Z',
			last_alert_at: null,
			accounts: { RohoolAgi: '1850000000000000001', Ajay_2512x: '1850000000000000009' },
		});
	});

	it('only ever moves a cursor forward, including across digit counts', async () => {
		await handleXStateWrite(new Request('https://x', keyed({ accounts: { RohoolAgi: '1850000000000000005' } })), TEST_ENV);
		await handleXStateWrite(new Request('https://x', keyed({ accounts: { RohoolAgi: '1850000000000000002' } })), TEST_ENV);
		expect((await state()).accounts.RohoolAgi).toBe('1850000000000000005');

		await handleXStateWrite(new Request('https://x', keyed({ accounts: { RohoolAgi: '9' } })), TEST_ENV);
		expect((await state()).accounts.RohoolAgi).toBe('1850000000000000005');

		await handleXStateWrite(new Request('https://x', keyed({ accounts: { RohoolAgi: '1850000000000000006' } })), TEST_ENV);
		expect((await state()).accounts.RohoolAgi).toBe('1850000000000000006');
	});

	it('rejects a bad handle, a non numeric id and a bad run_at, writing nothing', async () => {
		for (const body of [{ accounts: { 'bad handle!': '1' } }, { accounts: { RohoolAgi: 'abc' } }, { accounts: { RohoolAgi: '5' }, run_at: 'yesterday' }]) {
			expect((await handleXStateWrite(new Request('https://x', keyed(body)), TEST_ENV)).status).toBe(400);
		}
		expect((await state()).accounts).toEqual({});
	});

	it('does not leak the unrelated cursor row', async () => {
		expect(await state()).toMatchObject({ accounts: {} });
	});
});

describe('POST /x/alert', () => {
	it('sends one Telegram message with the prefix and escapes html', async () => {
		const response = await handleXAlert(new Request('https://x', keyed({ message: 'login failed <b>now</b>' })), TEST_ENV);
		expect(await response.json()).toEqual({ sent: true });

		expect(calls).toHaveLength(1);
		expect((calls[0]?.body as { text: string }).text).toBe('X scraper: login failed &lt;b&gt;now&lt;/b&gt;');
		expect((await state()).last_alert_at).not.toBeNull();
	});

	it('stays quiet during the cooldown, and speaks again after a good run', async () => {
		await handleXAlert(new Request('https://x', keyed({ message: 'first' })), TEST_ENV);
		const second = await handleXAlert(new Request('https://x', keyed({ message: 'second' })), TEST_ENV);
		expect(await second.json()).toEqual({ sent: false, reason: 'already alerted recently' });
		expect(calls).toHaveLength(1);

		await handleXStateWrite(new Request('https://x', keyed({ ok: true, run_at: '2026-10-28T11:00:00Z' })), TEST_ENV);
		expect((await state()).last_alert_at).toBeNull();

		const third = await handleXAlert(new Request('https://x', keyed({ message: 'third' })), TEST_ENV);
		expect(await third.json()).toEqual({ sent: true });
		expect(calls).toHaveLength(2);
	});

	it('does not start the cooldown when Telegram rejects the send', async () => {
		vi.unstubAllGlobals();
		calls = stubTelegram(['sendMessage']);
		const response = await handleXAlert(new Request('https://x', keyed({ message: 'hello' })), TEST_ENV);
		expect(response.status).toBe(502);
		expect((await state()).last_alert_at).toBeNull();
	});

	it('requires a message', async () => {
		expect((await handleXAlert(new Request('https://x', keyed({ message: '   ' })), TEST_ENV)).status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});
