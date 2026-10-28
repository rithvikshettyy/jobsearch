/**
 * Title normalisation for the dedupe key. Kills the noise ATSs add around the
 * same role: parenthetical suffixes, req numbers, seniority roman numerals,
 * punctuation, casing.
 */
export function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/\(([^)]*)\)/g, ' ')
		.replace(/\[[^\]]*\]/g, ' ')
		.replace(/\b(?:req|job|jr)[-#\s]?\d+\b/g, ' ')
		.replace(/[^a-z0-9+#.\s]+/g, ' ')
		.replace(/\b(i{1,3}|iv|v)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function sha256(payload: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
	return toHex(digest);
}

/**
 * sha256(company + '|' + normalizedTitle + '|' + location).
 * Web Crypto — `crypto.subtle` is the only hashing available on Workers.
 */
export async function dedupeKey(company: string, title: string, location: string): Promise<string> {
	return sha256(`${company}|${normalizeTitle(title)}|${location}`);
}

/**
 * sha256(lower(company) + '|' + normalizedTitle) — location left out on purpose.
 * The same role posted with a different location list (Datadog does this) or on
 * a second board is one job; callers merge the locations instead of re-sending.
 */
export async function fuzzyKey(company: string, title: string): Promise<string> {
	return sha256(`${company.trim().toLowerCase()}|${normalizeTitle(title)}`);
}

/** Union of two ";"-joined location lists, case-insensitive, first-seen order. */
export function mergeLocations(a: string, b: string): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of `${a};${b}`.split(';')) {
		const trimmed = part.trim();
		const key = trimmed.toLowerCase();
		if (trimmed === '' || seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out.join('; ');
}

/**
 * Collapse items sharing a fuzzy key into the first one, location lists merged.
 * `merged` counts the items that were absorbed.
 */
export function collapseByFuzzy<T extends { fuzzy: string; job: { location: string } }>(items: readonly T[]): { kept: T[]; merged: number } {
	const byKey = new Map<string, T>();
	let merged = 0;
	for (const item of items) {
		const first = byKey.get(item.fuzzy);
		if (first === undefined) {
			byKey.set(item.fuzzy, { ...item, job: { ...item.job } });
			continue;
		}
		first.job.location = mergeLocations(first.job.location, item.job.location);
		merged += 1;
	}
	return { kept: [...byKey.values()], merged };
}
