import { requireIngestKey } from './auth';
import { logError } from './store';
import { escapeHtml, sendMessage } from './telegram';
import type { Env } from './types';

/**
 * State for the local X scraper, kept in the `meta` table so it survives the scraper
 * running from a different machine (or GitHub Actions) next time:
 *
 *   x_last_id:<handle>   newest tweet id already handled for that account
 *   x_last_run_at        ISO time of the last attempt, success or not
 *   x_last_alert_at      ISO time of the last Telegram alert, cleared by a good run
 */
const ID_PREFIX = 'x_last_id:';
const KEY_RUN = 'x_last_run_at';
const KEY_ALERT = 'x_last_alert_at';

/** One alert per outage, not one per scheduled run. */
const ALERT_COOLDOWN_MS = 12 * 3_600_000;

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID = /^\d{1,25}$/;

/** Tweet ids are snowflakes, 19 digits and growing: compare as numbers without losing precision. */
function newer(candidate: string, current: string | undefined): boolean {
	if (current === undefined) return true;
	return candidate.length !== current.length ? candidate.length > current.length : candidate > current;
}

async function readMeta(env: Env): Promise<Map<string, string>> {
	const { results } = await env.DB.prepare(`SELECT key, value FROM meta WHERE key LIKE 'x\\_%' ESCAPE '\\'`).all<{ key: string; value: string }>();
	return new Map(results.map((row) => [row.key, row.value]));
}

/** GET /x/state */
export async function handleXState(request: Request, env: Env): Promise<Response> {
	const denied = await requireIngestKey(request, env);
	if (denied !== null) return denied;

	const meta = await readMeta(env);
	const accounts: Record<string, string> = {};
	for (const [key, value] of meta) {
		if (key.startsWith(ID_PREFIX)) accounts[key.slice(ID_PREFIX.length)] = value;
	}
	return Response.json({ last_run_at: meta.get(KEY_RUN) ?? null, last_alert_at: meta.get(KEY_ALERT) ?? null, accounts });
}

/**
 * POST /x/state  body: { "accounts": { "handle": "tweetid" }, "run_at": "<iso>", "ok": true }
 *
 * An id only ever moves forward, so a late or replayed call cannot rewind the
 * cursor and re-announce old tweets. `ok: true` clears the alert cooldown, so the
 * next outage alerts again.
 */
export async function handleXStateWrite(request: Request, env: Env): Promise<Response> {
	const denied = await requireIngestKey(request, env);
	if (denied !== null) return denied;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'body must be JSON' }, { status: 400 });
	}
	const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

	const accounts = typeof record.accounts === 'object' && record.accounts !== null ? (record.accounts as Record<string, unknown>) : {};
	const writes: Array<[string, string]> = [];
	const current = await readMeta(env);
	for (const [handle, id] of Object.entries(accounts)) {
		if (!HANDLE.test(handle) || typeof id !== 'string' || !TWEET_ID.test(id)) return Response.json({ error: `bad account entry "${handle}"` }, { status: 400 });
		if (newer(id, current.get(`${ID_PREFIX}${handle}`))) writes.push([`${ID_PREFIX}${handle}`, id]);
	}

	if (record.run_at !== undefined) {
		const parsed = typeof record.run_at === 'string' ? new Date(record.run_at) : null;
		if (parsed === null || Number.isNaN(parsed.getTime())) return Response.json({ error: 'run_at must be an ISO date' }, { status: 400 });
		writes.push([KEY_RUN, parsed.toISOString()]);
	}

	const statements = writes.map(([key, value]) => env.DB.prepare(`INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(key, value));
	if (record.ok === true) statements.push(env.DB.prepare(`DELETE FROM meta WHERE key = ?1`).bind(KEY_ALERT));
	if (statements.length > 0) await env.DB.batch(statements);

	return Response.json({ ok: true, written: writes.length });
}

/**
 * POST /x/alert  body: { "message": "..." }
 *
 * The scraper has no Telegram token of its own, the Worker does. At most one alert
 * per ALERT_COOLDOWN_MS, so a burner whose cookies expired does not page you every
 * 30 minutes.
 */
export async function handleXAlert(request: Request, env: Env): Promise<Response> {
	const denied = await requireIngestKey(request, env);
	if (denied !== null) return denied;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'body must be JSON' }, { status: 400 });
	}
	const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).message : undefined;
	const message = typeof raw === 'string' ? raw.trim().slice(0, 500) : '';
	if (message === '') return Response.json({ error: 'message is required' }, { status: 400 });

	const meta = await readMeta(env);
	const last = Date.parse(meta.get(KEY_ALERT) ?? '');
	if (!Number.isNaN(last) && Date.now() - last < ALERT_COOLDOWN_MS) return Response.json({ sent: false, reason: 'already alerted recently' });

	try {
		await sendMessage(env, `X scraper: ${escapeHtml(message)}`);
	} catch (error) {
		await logError(env, null, error instanceof Error ? error.message : String(error), 'x-alert');
		return Response.json({ sent: false, reason: 'telegram send failed' }, { status: 502 });
	}
	await env.DB.prepare(`INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(KEY_ALERT, new Date().toISOString()).run();
	return Response.json({ sent: true });
}
