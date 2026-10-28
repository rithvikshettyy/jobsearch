import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import type { Env } from '../src/types';

/** Env for calling a handler directly: the secrets the worker never has in tests. */
export const TEST_ENV: Env = {
	...env,
	INGEST_KEY: 'test-ingest-key',
	TG_WEBHOOK_SECRET: 'test-webhook-secret',
	TELEGRAM_BOT_TOKEN: 'test-token',
};

export interface BotCall {
	method: string;
	body: Record<string, unknown>;
}

/** Records every Telegram Bot API call instead of making it. `fail` lists methods that answer 500. */
export function stubTelegram(fail: string[] = []): BotCall[] {
	const calls: BotCall[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			const method = url.split('/').pop() ?? '';
			calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
			return fail.includes(method) ? new Response('boom', { status: 500 }) : Response.json({ ok: true });
		}),
	);
	return calls;
}

export async function resetJobs(): Promise<void> {
	await env.DB.batch([env.DB.prepare(`DELETE FROM jobs`), env.DB.prepare(`DELETE FROM errors`)]);
}

/** A row straight into the queue. Returns its rowid, the id the buttons carry. */
export async function insertJob(over: { title?: string; company?: string; status?: string; url?: string; location?: string; notified?: number } = {}): Promise<number> {
	const company = await env.DB.prepare(`SELECT id FROM companies WHERE name = 'Ingest'`).first<{ id: number }>();
	const title = over.title ?? 'AI Engineer';
	const key = `${over.company ?? 'Acme'}|${title}|${over.location ?? 'Pune, India'}|${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO jobs (dedupe_key, company_id, external_id, company, title, location, url, notified, created_at, status, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9)`,
	)
		.bind(key, company?.id ?? 0, key, over.company ?? 'Acme', title, over.location ?? 'Pune, India', over.url ?? `https://example.com/${key}`, over.notified ?? 1, new Date().toISOString(), over.status ?? 'new')
		.run();
	const row = await env.DB.prepare(`SELECT rowid AS id FROM jobs WHERE dedupe_key = ?1`).bind(key).first<{ id: number }>();
	return row?.id ?? 0;
}

export async function statusOf(id: number): Promise<string | null> {
	const row = await env.DB.prepare(`SELECT status FROM jobs WHERE rowid = ?1`).bind(id).first<{ status: string }>();
	return row?.status ?? null;
}
