import { JOBS_PER_MESSAGE } from './config';
import { escapeHtml } from './telegram';
import type { Env, Job } from './types';

/** Telegram's hard cap is 4096; the headroom absorbs the numbering and markup. */
const MAX_MESSAGE_CHARS = 4000;

/** Telegram rejects a button label over 64 chars. */
const MAX_BUTTON_CHARS = 64;

const SEND_TIMEOUT_MS = 8_000;

/** Reads as entry-level: the JD asks for a year or less. */
const PREFIX_ENTRY = '✅';

/** The JD never named a number — worth a look, but unverified. */
const PREFIX_UNKNOWN = '❓';

/** Above the entry bar but still inside the search's ceiling. */
const PREFIX_ABOVE = '🔸';

/**
 * A row ready to push. Structurally identical to store.ts's `UnnotifiedJob`, but
 * declared here so notify does not depend on the storage layer.
 */
export interface NotifyJob {
	hash: string;
	job: Job;
	yoeMin: number | null;
}

interface InlineButton {
	text: string;
	url: string;
}

export interface SendResult {
	/** Hashes Telegram accepted — the caller marks exactly these notified. */
	sent: string[];
	/** Hashes whose message failed. Left unsent so the next tick retries them. */
	failed: string[];
}

export function yoePrefix(yoeMin: number | null): string {
	if (yoeMin === null) return PREFIX_UNKNOWN;
	return yoeMin <= 1 ? PREFIX_ENTRY : PREFIX_ABOVE;
}

/** `2. ✅ <b>Stripe</b>: <a href="…">Software Engineer</a> — Bengaluru, India` */
export function formatLine(entry: NotifyJob, position: number): string {
	const { job } = entry;
	const location = job.location !== '' ? ` — ${escapeHtml(job.location)}` : '';
	const title = escapeHtml(job.title);
	const linked = isHttpUrl(job.url) ? `<a href="${escapeHtml(job.url)}">${title}</a>` : title;
	return `${position}. ${yoePrefix(entry.yoeMin)} <b>${escapeHtml(job.company)}</b>: ${linked}${location}`;
}

/**
 * Telegram only accepts http(s) in a URL button and 400s the whole send on
 * anything else — so a job with a junk URL silently loses its button rather
 * than taking the other four down with it.
 */
function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * One button per job, numbered to match the line it belongs to — five buttons
 * all reading "Apply" would be unusable otherwise.
 */
function buildKeyboard(entries: NotifyJob[]): InlineButton[][] {
	const rows: InlineButton[][] = [];
	entries.forEach((entry, index) => {
		if (!isHttpUrl(entry.job.url)) return;
		rows.push([{ text: `${index + 1} · Apply`.slice(0, MAX_BUTTON_CHARS), url: entry.job.url }]);
	});
	return rows;
}

/**
 * Split into messages of at most `perMessage` jobs, and under the char cap.
 *
 * A group is closed early when the next line would overflow, rather than
 * slicing the text — a cut mid-tag is invalid HTML and Telegram 400s the send.
 */
export function groupJobs(jobs: readonly NotifyJob[], perMessage = JOBS_PER_MESSAGE): NotifyJob[][] {
	const groups: NotifyJob[][] = [];
	let current: NotifyJob[] = [];
	let length = 0;

	for (const entry of jobs) {
		// Position within the group only shifts the leading number, so its width
		// is close enough for a budget check.
		const cost = formatLine(entry, current.length + 1).length + 2;
		if (current.length > 0 && (current.length >= perMessage || length + cost > MAX_MESSAGE_CHARS)) {
			groups.push(current);
			current = [];
			length = 0;
		}
		current.push(entry);
		length += cost;
	}

	if (current.length > 0) groups.push(current);
	return groups;
}

/** One subrequest. Throws on a non-2xx so `sendBatch` can bucket the group. */
async function postMessage(env: Env, text: string, keyboard: InlineButton[][]): Promise<void> {
	const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			chat_id: env.TELEGRAM_CHAT_ID,
			text,
			parse_mode: 'HTML',
			disable_web_page_preview: true,
			...(keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
		}),
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`telegram sendMessage failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
	}
}

/**
 * Push jobs in groups of `perMessage`, one subrequest each.
 *
 * Never throws: a failed group is reported in `failed` and the remaining groups
 * still go out. Only hashes in `sent` may be marked notified — anything else
 * stays in the outbox for the next tick.
 */
export async function sendBatch(env: Env, jobs: readonly NotifyJob[], perMessage = JOBS_PER_MESSAGE): Promise<SendResult> {
	const result: SendResult = { sent: [], failed: [] };
	if (jobs.length === 0) return result;

	for (const group of groupJobs(jobs, perMessage)) {
		const text = group.map((entry, index) => formatLine(entry, index + 1)).join('\n\n');
		try {
			await postMessage(env, text, buildKeyboard(group));
			for (const entry of group) result.sent.push(entry.hash);
		} catch {
			// Swallowed on purpose — the caller logs via the unsent hashes, and one
			// bad group must not strand the groups after it.
			for (const entry of group) result.failed.push(entry.hash);
		}
	}

	return result;
}
