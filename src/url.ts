/**
 * Query parameters that identify the visitor or the campaign, never the posting.
 * Everything else stays: `gh_jid` (Greenhouse embeds), `jid`, `id` and the like
 * decide WHICH job a URL points at.
 */
const TRACKING_PARAMS = new Set([
	'gclid',
	'fbclid',
	'msclkid',
	'yclid',
	'igshid',
	'mc_cid',
	'mc_eid',
	'mkt_tok',
	'ref',
	'ref_src',
	'refid',
	'referrer',
	'source',
	'src',
	'gh_src',
	'trk',
	'trkid',
	'tracking',
	'campaign',
	'cmpid',
	'vero_id',
	's',
	't',
]);

const TRACKING_PREFIXES = ['utm_', 'ga_', 'mtm_', 'pk_', 'hsa_', '_hs', 'li_', 'lever-'];

function isTracking(name: string): boolean {
	const key = name.toLowerCase();
	return TRACKING_PARAMS.has(key) || TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Canonical form of a posting URL, or null when it is not an http(s) URL.
 *
 * https, lowercase host without `www.`, no default port, no fragment, no
 * tracking params, remaining params sorted, no trailing slash. The path keeps
 * its case: some ATS ids are case-sensitive.
 */
export function normalizeUrl(raw: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

	const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
	if (host === '') return null;

	// A LinkedIn posting is identified by its number alone. The slug, the country subdomain (in.linkedin.com)
	// and every query parameter (trackingId, refId, position, currentJobId) change per visit and per search.
	if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
		const posting = /^\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/.exec(parsed.pathname);
		if (posting?.[1] !== undefined) return `https://www.linkedin.com/jobs/view/${posting[1]}`;
	}

	const kept = [...parsed.searchParams.entries()].filter(([name]) => !isTracking(name)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const query = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : '';
	const path = parsed.pathname.replace(/\/+$/, '');

	return `https://${host}${path}${query}`;
}
