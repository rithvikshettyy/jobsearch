import type { Env } from './types';

/**
 * Constant-time string compare. Both sides are hashed first so the loop always
 * walks 32 bytes, whatever the lengths.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [left, right] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))]);
	const x = new Uint8Array(left);
	const y = new Uint8Array(right);
	let diff = 0;
	for (let index = 0; index < x.length; index += 1) diff |= (x[index] ?? 0) ^ (y[index] ?? 0);
	return diff === 0;
}

/**
 * Gate for the machine endpoints (/ingest, /queue, /jobs/:id/status). Returns
 * null when the caller may proceed, otherwise the response to send.
 *
 * A missing INGEST_KEY secret closes the endpoints (503) rather than opening
 * them: an unset secret must never mean "no password".
 */
export async function requireIngestKey(request: Request, env: Env): Promise<Response | null> {
	const expected = env.INGEST_KEY ?? '';
	if (expected === '') return Response.json({ error: 'INGEST_KEY is not configured' }, { status: 503 });

	const given = request.headers.get('x-ingest-key') ?? '';
	if (given === '' || !(await safeEqual(given, expected))) return Response.json({ error: 'unauthorized' }, { status: 401 });
	return null;
}
