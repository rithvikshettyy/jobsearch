import { DIGEST_THRESHOLD, JOBS_PER_MESSAGE, SEND_PACE_MS } from './config';
import { escapeHtml } from './telegram';
import type { Env, Job } from './types';

/** Telegram's hard cap is 4096; the headroom absorbs the numbering and markup. */
const MAX_MESSAGE_CHARS = 4000;

const SEND_TIMEOUT_MS = 8_000;

/** Reads as entry-level: the JD asks for a year or less. */
const PREFIX_ENTRY = '✅';

/** The JD never named a number: worth a look, but unverified. */
const PREFIX_UNKNOWN = '❓';

/** Above the entry bar but still inside the search's ceiling. */
const PREFIX_ABOVE = '🔸';

/**
 * A row ready to push. Structurally identical to store.ts's `UnnotifiedJob`, but
 * declared here so notify does not depend on the storage layer.
 */
export interface NotifyJob {
	/** `jobs.rowid`, carried in the button callback data. */
	id: number;
	hash: string;
	job: Job;
	yoeMin: number | null;
	/** Comma-joined list of every source that reported the job. */
	sources?: string | null;
	tweetUrl?: string | null;
}

export interface InlineButton {
	text: string;
	callback_data: string;
}

/** `a:<id>` approves, `s:<id>` skips. Telegram caps callback data at 64 bytes; this is under 25. */
export const CALLBACK_PATTERN = /^([as]):(\d+)$/;

export const applyData = (id: number): string => `a:${id}`;
export const skipData = (id: number): string => `s:${id}`;

export interface SendResult {
	/** Hashes Telegram accepted, the caller marks exactly these notified. */
	sent: string[];
	/** Hashes whose message failed. Left unsent so the next tick retries them. */
	failed: string[];
}

export interface SendOptions {
	perMessage?: number;
	/** Pushes of more jobs than this go out as digests. */
	digestThreshold?: number;
	/** Pause between two sends. Tests pass 0. */
	paceMs?: number;
}

export function yoePrefix(yoeMin: number | null): string {
	if (yoeMin === null) return PREFIX_UNKNOWN;
	return yoeMin <= 1 ? PREFIX_ENTRY : PREFIX_ABOVE;
}

/**
 * Telegram only accepts http(s) in a link and 400s the whole send on anything
 * else, so a job with a junk URL loses its link rather than taking the others down.
 */
function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function linked(entry: NotifyJob): string {
	const title = escapeHtml(entry.job.title);
	return isHttpUrl(entry.job.url) ? `<a href="${escapeHtml(entry.job.url)}">${title}</a>` : title;
}

/** Digest row: `2. ✅ <b>Stripe</b>: <a href="...">Software Engineer</a> - Bengaluru, India` */
export function formatLine(entry: NotifyJob, position: number): string {
	const { job } = entry;
	const location = job.location !== '' ? ` - ${escapeHtml(job.location)}` : '';
	return `${position}. ${yoePrefix(entry.yoeMin)} <b>${escapeHtml(job.company)}</b>: ${linked(entry)}${location}`;
}

/** One job per message: company and linked title, then location, source and tweet on their own lines. */
export function formatSingle(entry: NotifyJob): string {
	const { job } = entry;
	const lines = [`${yoePrefix(entry.yoeMin)} <b>${escapeHtml(job.company)}</b>: ${linked(entry)}`];
	if (job.location !== '') lines.push(escapeHtml(job.location));
	if (entry.sources !== undefined && entry.sources !== null && entry.sources !== '') lines.push(`Source: ${escapeHtml(entry.sources.split(',').join(', '))}`);
	if (entry.tweetUrl !== undefined && entry.tweetUrl !== null && isHttpUrl(entry.tweetUrl)) lines.push(`<a href="${escapeHtml(entry.tweetUrl)}">Tweet</a>`);
	return lines.join('\n');
}

export function singleKeyboard(id: number): InlineButton[][] {
	return [
		[
			{ text: '✅ Apply', callback_data: applyData(id) },
			{ text: '❌ Skip', callback_data: skipData(id) },
		],
	];
}

/** Digest buttons are numbered to match the line they belong to. */
function digestKeyboard(entries: NotifyJob[]): InlineButton[][] {
	return entries.map((entry, index) => [
		{ text: `✅ Apply ${index + 1}`, callback_data: applyData(entry.id) },
		{ text: `❌ Skip ${index + 1}`, callback_data: skipData(entry.id) },
	]);
}

/**
 * Split into messages of at most `perMessage` jobs, and under the char cap.
 *
 * A group is closed early when the next line would overflow, rather than
 * slicing the text: a cut mid-tag is invalid HTML and Telegram 400s the send.
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

interface Outgoing {
	entries: NotifyJob[];
	text: string;
	keyboard: InlineButton[][];
}

/**
 * How `jobs` will be sent: up to `digestThreshold` jobs go one per message, each
 * with its own buttons; more than that is grouped into digests. The message count
 * is what the caller has to budget as subrequests.
 */
export function planMessages(jobs: readonly NotifyJob[], options: SendOptions = {}): Outgoing[] {
	const threshold = options.digestThreshold ?? DIGEST_THRESHOLD;
	if (jobs.length <= threshold) {
		return jobs.map((entry) => ({ entries: [entry], text: formatSingle(entry), keyboard: singleKeyboard(entry.id) }));
	}
	return groupJobs(jobs, options.perMessage ?? JOBS_PER_MESSAGE).map((group) => ({
		entries: group,
		text: group.map((entry, index) => formatLine(entry, index + 1)).join('\n\n'),
		keyboard: digestKeyboard(group),
	}));
}

/** One subrequest. Throws on a non-2xx so `sendBatch` can bucket the message. */
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Push jobs, one subrequest per message, about one message a second.
 *
 * Never throws: a failed message is reported in `failed` and the rest still go
 * out. Only hashes in `sent` may be marked notified, anything else stays in the
 * outbox for the next tick.
 */
export async function sendBatch(env: Env, jobs: readonly NotifyJob[], options: SendOptions = {}): Promise<SendResult> {
	const result: SendResult = { sent: [], failed: [] };
	if (jobs.length === 0) return result;

	const pace = options.paceMs ?? SEND_PACE_MS;
	let first = true;
	for (const message of planMessages(jobs, options)) {
		if (!first && pace > 0) await sleep(pace);
		first = false;
		try {
			await postMessage(env, message.text, message.keyboard);
			for (const entry of message.entries) result.sent.push(entry.hash);
		} catch {
			// Swallowed on purpose: the caller logs via the unsent hashes, and one
			// bad message must not strand the ones after it.
			for (const entry of message.entries) result.failed.push(entry.hash);
		}
	}

	return result;
}
