const USER_AGENT = 'job-bot (+https://workers.cloudflare.com)';
const DEFAULT_TIMEOUT_MS = 8_000;

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly url: string,
	) {
		super(`HTTP ${status} for ${url}`);
		this.name = 'HttpError';
	}
}

/**
 * One subrequest. Typed as `unknown` on purpose — every caller narrows with its
 * own guard rather than casting, so a board changing shape fails loudly in the
 * source module instead of silently producing half-empty rows.
 *
 * `headers` is for keyed APIs only (RapidAPI wants the key in a header, not the
 * query string). It merges over the defaults, so a caller can override the
 * user-agent but never has to restate `accept`.
 */
export async function getJson(url: string, timeoutMs = DEFAULT_TIMEOUT_MS, headers: Record<string, string> = {}): Promise<unknown> {
	const response = await fetch(url, {
		headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new HttpError(response.status, url);
	return await response.json();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
}

/** ISO-8601 or null. Accepts epoch millis (Lever) and date strings (Greenhouse, Ashby). */
export function asIsoDate(value: unknown): string | null {
	if (typeof value === 'number') {
		const fromEpoch = new Date(value);
		return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch.toISOString();
	}
	if (typeof value !== 'string' || value === '') return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Cheap tag strip for descriptions. Runs in the DETAIL path only — never on the
 * poll path, where full JDs are not even read.
 */
export function stripHtml(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#\d+;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
