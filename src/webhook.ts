import { safeEqual } from './auth';
import { CALLBACK_PATTERN, formatSingle, type NotifyJob } from './notify';
import { getJob, moveJob, type JobStatus, type QueueJob } from './queue';
import { logError } from './store';
import { callBot } from './telegram';
import type { Env } from './types';

interface Button {
	text?: unknown;
	callback_data?: unknown;
}

type Keyboard = Button[][];

const STATUS_LABEL: Record<JobStatus, string> = {
	new: 'Waiting',
	approved: '✅ Approved',
	skipped: '❌ Skipped',
	applying: 'Applying',
	applied: '✅ Applied',
	failed: 'Failed',
	manual: 'Needs a manual apply',
};

function record(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function keyboardOf(message: Record<string, unknown>): Keyboard {
	const rows = record(message.reply_markup).inline_keyboard;
	if (!Array.isArray(rows)) return [];
	return rows.filter(Array.isArray).map((row) => (row as unknown[]).map((button) => record(button) as Button));
}

/** Job id a button belongs to, or null for any button this bot did not write. */
function idOfButton(button: Button): number | null {
	const match = typeof button.callback_data === 'string' ? CALLBACK_PATTERN.exec(button.callback_data) : null;
	return match?.[2] === undefined ? null : Number(match[2]);
}

function asEntry(job: QueueJob): NotifyJob {
	return {
		id: job.id,
		hash: '',
		job: { externalId: '', company: job.company, title: job.title, location: job.location, url: job.url, postedAt: null },
		yoeMin: job.yoeMin,
		sources: job.sources ?? job.source,
		tweetUrl: job.tweetUrl,
	};
}

/**
 * POST /tg-webhook. Telegram calls it for every update once `setWebhook` points here.
 *
 * Three checks before anything is read: the secret header (403), then the chat
 * (and, if configured, the user) the tap came from. A tap from anywhere else is
 * dropped without a reply, so the bot gives a stranger nothing to probe.
 *
 * After that it always answers 200: Telegram retries a non-2xx forever, and a
 * failed edit must not turn into a retry storm. Failures go to `errors`.
 */
export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
	const secret = env.TG_WEBHOOK_SECRET ?? '';
	if (secret === '') return Response.json({ error: 'TG_WEBHOOK_SECRET is not configured' }, { status: 503 });
	const given = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
	if (given === '' || !(await safeEqual(given, secret))) return new Response('forbidden', { status: 403 });

	let update: Record<string, unknown>;
	try {
		update = record(await request.json());
	} catch {
		return Response.json({ error: 'body must be JSON' }, { status: 400 });
	}

	const query = record(update.callback_query);
	if (typeof query.id !== 'string') return Response.json({ ok: true, ignored: 'not a button tap' });

	const message = record(query.message);
	const chatId = String(record(message.chat).id ?? '');
	if (chatId === '' || chatId !== env.TELEGRAM_CHAT_ID) return Response.json({ ok: true, ignored: 'wrong chat' });
	const owner = env.TELEGRAM_OWNER_USER_ID ?? '';
	if (owner !== '' && String(record(query.from).id ?? '') !== owner) return Response.json({ ok: true, ignored: 'wrong user' });

	try {
		await respond(env, query.id, query.data, message, chatId);
	} catch (error) {
		await logError(env, null, error instanceof Error ? error.message : String(error), 'webhook');
	}
	return Response.json({ ok: true });
}

async function respond(env: Env, queryId: string, data: unknown, message: Record<string, unknown>, chatId: string): Promise<void> {
	const match = typeof data === 'string' ? CALLBACK_PATTERN.exec(data) : null;
	if (match?.[1] === undefined || match[2] === undefined) {
		await callBot(env, 'answerCallbackQuery', { callback_query_id: queryId, text: 'Unknown button' });
		return;
	}

	const id = Number(match[2]);
	const to: JobStatus = match[1] === 'a' ? 'approved' : 'skipped';

	// Only a waiting job answers to a button: a stale one can never reopen a skipped job.
	const moved = await moveJob(env, id, to, { onlyFrom: 'new' });
	const job = moved.ok ? moved.job : await getJob(env, id);

	let toast: string;
	let label: string;
	if (moved.ok) {
		toast = `${to === 'approved' ? 'Approved' : 'Skipped'}: ${moved.job.title}`.slice(0, 190);
		label = STATUS_LABEL[to];
	} else if (job === null) {
		toast = 'Job not found';
		label = 'Job not found';
	} else {
		toast = `Already ${job.status}`;
		label = STATUS_LABEL[job.status];
	}
	await callBot(env, 'answerCallbackQuery', { callback_query_id: queryId, text: toast });

	const messageId = message.message_id;
	if (typeof messageId !== 'number') return;

	const rows = keyboardOf(message);
	const ids = new Set(rows.flat().map(idOfButton).filter((value): value is number => value !== null));

	if (ids.size > 1) {
		// A digest: drop this job's row, leave the others tappable.
		const remaining = rows.filter((row) => !row.some((button) => idOfButton(button) === id));
		await callBot(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: remaining } });
		return;
	}

	// One job per message: rewrite it with the decision and take the buttons off.
	if (job === null) {
		await callBot(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
		return;
	}
	await callBot(env, 'editMessageText', {
		chat_id: chatId,
		message_id: messageId,
		text: `${formatSingle(asEntry(job))}\n\n${label}`,
		parse_mode: 'HTML',
		disable_web_page_preview: true,
		reply_markup: { inline_keyboard: [] },
	});
}
