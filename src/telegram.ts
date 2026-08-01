import type { Env, Job } from './types';

const MAX_MESSAGE_CHARS = 4000; // Telegram hard limit is 4096.

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatJob(job: Job): string {
	const location = job.location !== '' ? ` — ${escapeHtml(job.location)}` : '';
	return `<b>${escapeHtml(job.company)}</b>: <a href="${escapeHtml(job.url)}">${escapeHtml(job.title)}</a>${location}`;
}

/** Groups jobs into as few messages as possible — each send is a subrequest. */
export function buildMessages(jobs: Job[], perMessage: number): string[] {
	const messages: string[] = [];
	for (let index = 0; index < jobs.length; index += perMessage) {
		const chunk = jobs.slice(index, index + perMessage).map(formatJob).join('\n\n');
		messages.push(chunk.slice(0, MAX_MESSAGE_CHARS));
	}
	return messages;
}

/** One subrequest. Throws on a non-2xx so the caller can log it to `errors`. */
export async function sendMessage(env: Env, text: string): Promise<void> {
	const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			chat_id: env.TELEGRAM_CHAT_ID,
			text,
			parse_mode: 'HTML',
			disable_web_page_preview: true,
		}),
		signal: AbortSignal.timeout(8_000),
	});
	if (!response.ok) {
		throw new Error(`telegram sendMessage failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
	}
}
