import { requireIngestKey } from './auth';
import { DEDUPE_WINDOW_DAYS, FILTERS, MAX_INGEST_ITEMS, SEND_UNKNOWN_YOE, SUBREQUEST_CAP, TRUSTED_INGEST_SOURCES } from './config';
import { dedupeKey, fuzzyKey, mergeLocations } from './dedupe';
import { eligibleLocations, isFresh, roleOk } from './filters';
import { SubrequestBudget } from './limit';
import { pushOutbox } from './outbox';
import { detailGate } from './pipeline';
import { addSources, existingHashes, findByUrlNorm, insertJobs, logError, recentByFuzzy, updateLocations, type PendingJob } from './store';
import { normalizeUrl } from './url';
import type { Env, JobDetail } from './types';

/** One job as a source posts it. Snake case on the wire, camel case in here. */
interface IngestItem {
	url: string;
	norm: string;
	title: string;
	company: string;
	location: string;
	remote: boolean;
	yoeMin: number | null;
	source: string;
	postedAt: string | null;
	snippet: string;
	tweetUrl: string | null;
}

type ItemResult = { result: 'queued' } | { result: 'duplicate' } | { result: 'filtered'; reason: string } | { result: 'invalid'; reason: string };

const SOURCE_PATTERN = /^[a-z0-9_.-]{1,32}$/;
const MAX_BODY_CHARS = 400_000;

function text(value: unknown, max: number): string {
	return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** The item, or the reason it is unusable. */
function parseItem(raw: unknown): IngestItem | string {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'item must be an object';
	const record = raw as Record<string, unknown>;

	const url = text(record.url, 2048);
	const norm = normalizeUrl(url);
	if (norm === null) return 'url must be an http(s) url';

	const title = text(record.title, 300);
	if (title === '') return 'title is required';
	const company = text(record.company, 200);
	if (company === '') return 'company is required';
	const source = text(record.source, 32).toLowerCase();
	if (!SOURCE_PATTERN.test(source)) return 'source must be 1-32 chars of a-z 0-9 _ . -';

	const yoe = record.yoe_min;
	if (yoe !== undefined && yoe !== null && !(typeof yoe === 'number' && Number.isInteger(yoe) && yoe >= 0 && yoe <= 40)) return 'yoe_min must be an integer 0-40 or null';

	let postedAt: string | null = null;
	if (typeof record.posted_at === 'string' && record.posted_at !== '') {
		const parsed = new Date(record.posted_at);
		if (Number.isNaN(parsed.getTime())) return 'posted_at must be a date';
		postedAt = parsed.toISOString();
	}

	const tweet = text(record.tweet_url, 2048);
	return {
		url,
		norm,
		title,
		company,
		location: text(record.location, 300),
		remote: record.remote === true,
		yoeMin: typeof yoe === 'number' ? yoe : null,
		source,
		postedAt,
		snippet: text(record.description_snippet, 2000),
		tweetUrl: tweet !== '' && normalizeUrl(tweet) !== null ? tweet : null,
	};
}

/**
 * The same gates a polled job goes through, so a source cannot bypass the search by
 * posting to /ingest: role, place, freshness, then the JD checks on whatever text
 * came with it (snippet, and `yoe_min` when the source knows it).
 *
 * Trusted sources skip all of it. Returns the location narrowed to the places this
 * search can serve, as the polled path does.
 */
function gate(item: IngestItem, env: Env, now: number): { ok: true; location: string } | { ok: false; reason: string } {
	if (TRUSTED_INGEST_SOURCES.includes(item.source)) return { ok: true, location: item.location };

	if (!roleOk(item.title, FILTERS)) return { ok: false, reason: 'title' };

	let location = item.location;
	const place = location !== '' ? location : item.remote ? 'Remote' : '';
	if (place !== '') {
		const places = eligibleLocations(place, FILTERS);
		if (places.length === 0) return { ok: false, reason: 'location' };
		location = places.join('; ');
	}

	if (!isFresh(item.postedAt, FILTERS, now)) return { ok: false, reason: 'stale' };

	const detail: JobDetail = {
		externalId: item.norm,
		company: item.company,
		title: item.title,
		location,
		url: item.url,
		postedAt: item.postedAt,
		description: item.snippet,
		yoeMin: item.yoeMin,
	};
	const sendUnknownYoe = env.SEND_UNKNOWN_YOE === undefined ? SEND_UNKNOWN_YOE : env.SEND_UNKNOWN_YOE === 'true';
	const outcome = detailGate(detail, FILTERS, { sendUnknownYoe });
	if (!outcome.ok) return { ok: false, reason: outcome.reason };
	return { ok: true, location };
}

async function ingestCompanyId(env: Env): Promise<number> {
	const row = await env.DB.prepare(`SELECT id FROM companies WHERE name = 'Ingest' AND source = 'ingest'`).first<{ id: number }>();
	if (row === null) throw new Error("ingest: the 'Ingest' company row is missing, run migration 0008");
	return row.id;
}

function readItems(body: unknown): unknown[] | null {
	if (Array.isArray(body)) return body;
	if (typeof body === 'object' && body !== null) {
		const jobs = (body as Record<string, unknown>).jobs;
		return Array.isArray(jobs) ? jobs : [body];
	}
	return null;
}

/**
 * POST /ingest. Accepts one job, an array, or `{ "jobs": [...] }`, at most
 * MAX_INGEST_ITEMS. Each item is validated, gated, deduped against every source
 * (normalised URL first, then company + title inside DEDUPE_WINDOW_DAYS), queued as
 * `new`, and announced with Apply and Skip buttons.
 */
export async function handleIngest(request: Request, env: Env): Promise<Response> {
	const denied = await requireIngestKey(request, env);
	if (denied !== null) return denied;

	const raw = await request.text();
	if (raw.length > MAX_BODY_CHARS) return Response.json({ error: 'body too large' }, { status: 413 });
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return Response.json({ error: 'body must be JSON' }, { status: 400 });
	}
	const items = readItems(body);
	if (items === null || items.length === 0) return Response.json({ error: 'send a job, an array, or { "jobs": [...] }' }, { status: 400 });
	if (items.length > MAX_INGEST_ITEMS) return Response.json({ error: `at most ${MAX_INGEST_ITEMS} jobs per request` }, { status: 413 });

	try {
		const now = Date.now();
		const results: ItemResult[] = new Array<ItemResult>(items.length);
		const survivors: Array<{ index: number; item: IngestItem; location: string }> = [];

		items.forEach((entry, index) => {
			const parsed = parseItem(entry);
			if (typeof parsed === 'string') {
				results[index] = { result: 'invalid', reason: parsed };
				return;
			}
			const verdict = gate(parsed, env, now);
			if (!verdict.ok) {
				results[index] = { result: 'filtered', reason: verdict.reason };
				return;
			}
			survivors.push({ index, item: parsed, location: verdict.location });
		});

		// One batched lookup per kind, never one query per item.
		const sightings: Array<{ dedupeKey: string; source: string }> = [];
		const locationUpdates = new Map<string, string>();

		const byUrl = await findByUrlNorm(env, survivors.map((entry) => entry.item.norm));
		const firstSeen = new Map<string, number>();
		const open: Array<{ index: number; item: IngestItem; location: string; hash: string; fuzzy: string }> = [];
		for (const entry of survivors) {
			const known = byUrl.get(entry.item.norm);
			if (known !== undefined) {
				sightings.push({ dedupeKey: known, source: entry.item.source });
				results[entry.index] = { result: 'duplicate' };
				continue;
			}
			if (firstSeen.has(entry.item.norm)) {
				results[entry.index] = { result: 'duplicate' };
				continue;
			}
			firstSeen.set(entry.item.norm, entry.index);
			open.push({
				...entry,
				hash: await dedupeKey(entry.item.company, entry.item.title, entry.location),
				fuzzy: await fuzzyKey(entry.item.company, entry.item.title),
			});
		}

		const sameKey = await existingHashes(env, open.map((entry) => entry.hash));
		const since = new Date(now - DEDUPE_WINDOW_DAYS * 86_400_000).toISOString();
		const recent = await recentByFuzzy(env, open.map((entry) => entry.fuzzy), since);

		const fresh: PendingJob[] = [];
		const freshByFuzzy = new Map<string, PendingJob>();
		const companyId = open.length > 0 ? await ingestCompanyId(env) : 0;
		for (const entry of open) {
			if (sameKey.has(entry.hash)) {
				sightings.push({ dedupeKey: entry.hash, source: entry.item.source });
				results[entry.index] = { result: 'duplicate' };
				continue;
			}
			const match = recent.get(entry.fuzzy);
			if (match !== undefined) {
				locationUpdates.set(match.dedupeKey, mergeLocations(locationUpdates.get(match.dedupeKey) ?? match.locations, entry.location));
				sightings.push({ dedupeKey: match.dedupeKey, source: entry.item.source });
				results[entry.index] = { result: 'duplicate' };
				continue;
			}
			const twin = freshByFuzzy.get(entry.fuzzy);
			if (twin !== undefined) {
				twin.job = { ...twin.job, location: mergeLocations(twin.job.location, entry.location) };
				results[entry.index] = { result: 'duplicate' };
				continue;
			}

			const pending: PendingJob = {
				hash: entry.hash,
				fuzzy: entry.fuzzy,
				companyId,
				source: entry.item.source,
				tweetUrl: entry.item.tweetUrl,
				job: {
					externalId: entry.item.norm,
					company: entry.item.company,
					title: entry.item.title,
					location: entry.location,
					url: entry.item.url,
					postedAt: entry.item.postedAt,
					description: entry.item.snippet,
					yoeMin: entry.item.yoeMin,
				},
			};
			fresh.push(pending);
			freshByFuzzy.set(entry.fuzzy, pending);
			results[entry.index] = { result: 'queued' };
		}

		await updateLocations(
			env,
			[...locationUpdates].map(([key, locations]) => ({ dedupeKey: key, locations })),
		);
		await addSources(env, sightings);
		await insertJobs(env, fresh);

		// A tweet is announced the same way a polled job is: from the outbox.
		const pushed = await pushOutbox(env, new SubrequestBudget(SUBREQUEST_CAP));

		const count = (name: ItemResult['result']): number => results.filter((entry) => entry.result === name).length;
		return Response.json({
			queued: count('queued'),
			duplicate: count('duplicate'),
			filtered: count('filtered'),
			invalid: count('invalid'),
			notified: pushed.notified,
			results,
		});
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		await logError(env, null, message, 'ingest');
		// Only a caller holding INGEST_KEY sees this, and a 500 that names nothing is what made the first
		// failure on prod impossible to diagnose from the outside.
		console.error(`ingest failed: ${message.slice(0, 300)}`);
		return Response.json({ error: 'ingest failed', detail: message.slice(0, 300) }, { status: 500 });
	}
}
