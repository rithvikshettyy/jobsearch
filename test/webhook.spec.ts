import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTelegramWebhook } from '../src/webhook';
import { insertJob, resetJobs, statusOf, stubTelegram, TEST_ENV, type BotCall } from './helpers';

const CHAT = TEST_ENV.TELEGRAM_CHAT_ID;
let calls: BotCall[];

beforeEach(async () => {
	await resetJobs();
	calls = stubTelegram();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function hook(update: unknown, secret: string | null = TEST_ENV.TG_WEBHOOK_SECRET ?? ''): Request {
	return new Request('https://x/tg-webhook', {
		method: 'POST',
		headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret },
		body: JSON.stringify(update),
	});
}

type Row = Array<{ text: string; callback_data: string }>;

function tap(data: string, keyboard: Row[], over: { chat?: string | number; from?: number } = {}): unknown {
	return {
		update_id: 1,
		callback_query: {
			id: 'cb-1',
			from: { id: over.from ?? 4242 },
			data,
			message: { message_id: 77, chat: { id: over.chat ?? CHAT }, text: 'ignored', reply_markup: { inline_keyboard: keyboard } },
		},
	};
}

const single = (id: number): Row[] => [
	[
		{ text: '✅ Apply', callback_data: `a:${id}` },
		{ text: '❌ Skip', callback_data: `s:${id}` },
	],
];

const called = (method: string): BotCall[] => calls.filter((call) => call.method === method);

describe('POST /tg-webhook access', () => {
	it('answers 503 when the secret is unset, never open', async () => {
		const response = await handleTelegramWebhook(hook({}), { ...TEST_ENV, TG_WEBHOOK_SECRET: undefined });
		expect(response.status).toBe(503);
	});

	it('answers 403 for a missing or wrong secret header and touches nothing', async () => {
		const id = await insertJob();
		expect((await handleTelegramWebhook(hook(tap(`a:${id}`, single(id)), null), TEST_ENV)).status).toBe(403);
		expect((await handleTelegramWebhook(hook(tap(`a:${id}`, single(id)), 'nope'), TEST_ENV)).status).toBe(403);
		expect(await statusOf(id)).toBe('new');
		expect(calls).toHaveLength(0);
	});

	it('ignores a tap from another chat without replying', async () => {
		const id = await insertJob();
		const response = await handleTelegramWebhook(hook(tap(`a:${id}`, single(id), { chat: 999_001 })), TEST_ENV);
		expect(response.status).toBe(200);
		expect(await statusOf(id)).toBe('new');
		expect(calls).toHaveLength(0);
	});

	it('ignores a tap from the wrong user when an owner id is set', async () => {
		const id = await insertJob();
		const response = await handleTelegramWebhook(hook(tap(`a:${id}`, single(id), { from: 5 })), { ...TEST_ENV, TELEGRAM_OWNER_USER_ID: '4242' });
		expect(response.status).toBe(200);
		expect(await statusOf(id)).toBe('new');
		expect(calls).toHaveLength(0);

		await handleTelegramWebhook(hook(tap(`a:${id}`, single(id), { from: 4242 })), { ...TEST_ENV, TELEGRAM_OWNER_USER_ID: '4242' });
		expect(await statusOf(id)).toBe('approved');
	});

	it('ignores a plain message update', async () => {
		const response = await handleTelegramWebhook(hook({ update_id: 2, message: { text: 'hi', chat: { id: CHAT } } }), TEST_ENV);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(0);
	});
});

describe('POST /tg-webhook button taps', () => {
	it('approves: updates the job, answers the tap, rewrites the message with no buttons', async () => {
		const id = await insertJob({ title: 'ML Engineer', company: 'Acme' });
		const response = await handleTelegramWebhook(hook(tap(`a:${id}`, single(id))), TEST_ENV);
		expect(response.status).toBe(200);
		expect(await statusOf(id)).toBe('approved');

		expect(called('answerCallbackQuery')[0]?.body).toMatchObject({ callback_query_id: 'cb-1', text: 'Approved: ML Engineer' });
		const edit = called('editMessageText')[0]?.body as { text: string; chat_id: string; message_id: number; reply_markup: { inline_keyboard: unknown[] } };
		expect(edit.message_id).toBe(77);
		expect(edit.text).toContain('Acme');
		expect(edit.text).toContain('Approved');
		expect(edit.reply_markup.inline_keyboard).toEqual([]);
	});

	it('skips', async () => {
		const id = await insertJob();
		await handleTelegramWebhook(hook(tap(`s:${id}`, single(id))), TEST_ENV);
		expect(await statusOf(id)).toBe('skipped');
		expect((called('editMessageText')[0]?.body as { text: string }).text).toContain('Skipped');
	});

	it('a second tap on a decided job changes nothing and says so', async () => {
		const id = await insertJob();
		await handleTelegramWebhook(hook(tap(`a:${id}`, single(id))), TEST_ENV);
		calls.length = 0;

		await handleTelegramWebhook(hook(tap(`s:${id}`, single(id))), TEST_ENV);
		expect(await statusOf(id)).toBe('approved');
		expect(called('answerCallbackQuery')[0]?.body).toMatchObject({ text: 'Already approved' });
	});

	it('in a digest, removes only the tapped job row', async () => {
		const first = await insertJob({ title: 'AI Engineer' });
		const second = await insertJob({ title: 'LLM Engineer' });
		const digest: Row[] = [
			[
				{ text: '✅ Apply 1', callback_data: `a:${first}` },
				{ text: '❌ Skip 1', callback_data: `s:${first}` },
			],
			[
				{ text: '✅ Apply 2', callback_data: `a:${second}` },
				{ text: '❌ Skip 2', callback_data: `s:${second}` },
			],
		];
		await handleTelegramWebhook(hook(tap(`a:${first}`, digest)), TEST_ENV);

		expect(await statusOf(first)).toBe('approved');
		expect(await statusOf(second)).toBe('new');
		expect(called('editMessageText')).toHaveLength(0);
		const markup = called('editMessageReplyMarkup')[0]?.body as { reply_markup: { inline_keyboard: Row[] } };
		expect(markup.reply_markup.inline_keyboard).toEqual([digest[1]]);
	});

	it('answers a stale button for a job that no longer exists', async () => {
		const response = await handleTelegramWebhook(hook(tap('a:999999', single(999_999))), TEST_ENV);
		expect(response.status).toBe(200);
		expect(called('answerCallbackQuery')[0]?.body).toMatchObject({ text: 'Job not found' });
	});

	it('answers an unknown button', async () => {
		await handleTelegramWebhook(hook(tap('zzz', [])), TEST_ENV);
		expect(called('answerCallbackQuery')[0]?.body).toMatchObject({ text: 'Unknown button' });
	});

	it('still answers 200, and logs, when Telegram rejects the edit', async () => {
		vi.unstubAllGlobals();
		calls = stubTelegram(['editMessageText']);
		const id = await insertJob();

		const response = await handleTelegramWebhook(hook(tap(`a:${id}`, single(id))), TEST_ENV);
		expect(response.status).toBe(200);
		expect(await statusOf(id)).toBe('approved');

		const logged = await env.DB.prepare(`SELECT stage, message FROM errors`).first<{ stage: string; message: string }>();
		expect(logged?.stage).toBe('webhook');
		expect(logged?.message).not.toContain(TEST_ENV.TELEGRAM_BOT_TOKEN);
	});
});
