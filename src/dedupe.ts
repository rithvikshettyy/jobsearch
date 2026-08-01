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

/**
 * sha256(company + '|' + normalizedTitle + '|' + location).
 * Web Crypto — `crypto.subtle` is the only hashing available on Workers.
 */
export async function dedupeKey(company: string, title: string, location: string): Promise<string> {
	const payload = `${company}|${normalizeTitle(title)}|${location}`;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
	return toHex(digest);
}
