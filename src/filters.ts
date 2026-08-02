import type { Job, JobDetail } from './types';

export interface FilterConfig {
	/** Title must contain at least one of these (lowercase substrings). Empty = allow all. */
	titleAllow: string[];
	/** Title containing any of these is dropped. Wins over `titleAllow`. */
	titleDeny: string[];
	/** Location must contain one of these. Empty = allow all. */
	locationAllow: string[];
	/** Treat "remote"/"anywhere" locations as a match regardless of `locationAllow`. */
	allowRemote: boolean;
	/** Drop postings older than this. 0 = no age check. */
	maxAgeDays: number;
	/** Description must contain at least one. Empty = allow all. Phase 2 only. */
	descriptionAllow: string[];
	/** Description containing any of these is dropped. Phase 2 only. */
	descriptionDeny: string[];
}

const REMOTE_HINTS = ['remote', 'anywhere', 'distributed', 'work from home'];

function containsAny(haystack: string, needles: string[]): boolean {
	const lowered = haystack.toLowerCase();
	return needles.some((needle) => lowered.includes(needle.toLowerCase()));
}

export function matchesTitle(title: string, config: FilterConfig): boolean {
	if (containsAny(title, config.titleDeny)) return false;
	return config.titleAllow.length === 0 || containsAny(title, config.titleAllow);
}

export function isRemote(location: string): boolean {
	return containsAny(location, REMOTE_HINTS);
}

export function matchesLocation(location: string, config: FilterConfig): boolean {
	if (config.allowRemote && isRemote(location)) return true;
	return config.locationAllow.length === 0 || containsAny(location, config.locationAllow);
}

export function isFresh(postedAt: string | null, config: FilterConfig, now: number): boolean {
	if (config.maxAgeDays <= 0 || postedAt === null) return true;
	const posted = Date.parse(postedAt);
	if (Number.isNaN(posted)) return true;
	return now - posted <= config.maxAgeDays * 86_400_000;
}

/**
 * Phase-1 gate. Runs on the light payload, before any JD is fetched — this is
 * what keeps the detail fetches inside the subrequest budget.
 */
export function passesLightFilters(job: Job, config: FilterConfig, now: number): boolean {
	return matchesTitle(job.title, config) && matchesLocation(job.location, config) && isFresh(job.postedAt, config, now);
}

/** Phase-2 gate. Only ever called on a JD that already passed phase 1. */
export function passesDetailFilters(job: JobDetail, config: FilterConfig): boolean {
	if (containsAny(job.description, config.descriptionDeny)) return false;
	return config.descriptionAllow.length === 0 || containsAny(job.description, config.descriptionAllow);
}

// ---------------------------------------------------------------------------
// Config-free gates. These encode the parts of the search that never change —
// seniority, work authorization, years of experience — so they hold even when
// `FilterConfig` is empty. All pure: same input, same answer, no I/O.
// ---------------------------------------------------------------------------

/** Title words that mean "not an entry-level req", whatever the config says. */
const SENIORITY_DENY = [
	'senior',
	'sr.',
	// 'staff' deliberately absent: the search asks for staff engineer titles.
	// The YOE gate still filters them, since most staff reqs name a floor well
	// above `yoeOk`'s default of 2.
	'principal',
	'distinguished',
	'lead',
	'manager',
	'director',
	'head of',
	'vp',
	'vice president',
	'architect',
	'intern',
	'internship',
];

/** Phrases that gate a req behind citizenship or a visa this search cannot clear. */
const WORK_AUTH_DENY = [
	'authorized to work in the us',
	'authorization to work in the us',
	'us work authorization',
	'must be a us citizen',
	'us citizen',
	'permanent resident',
	'green card',
	'security clearance',
	'no visa sponsorship',
	'without sponsorship',
	'not provide sponsorship',
	'unable to sponsor',
];

/**
 * Regions a posting can be tied to that this search cannot serve. Used ONLY to
 * qualify a "remote" match: "Remote" alone is a real match, "Portugal, Remote"
 * and "US-Remote, Chicago" are not. Never applied to a job description, where
 * these words appear in passing all the time.
 */
const FOREIGN_REGION = [
	'us',
	'usa',
	'united states',
	'north america',
	'canada',
	'uk',
	'united kingdom',
	'ireland',
	'emea',
	'eu',
	'europe',
	'latam',
	'latin america',
	'australia',
	'new zealand',
	'germany',
	'france',
	'spain',
	'portugal',
	'italy',
	'netherlands',
	'poland',
	'romania',
	'ukraine',
	'brazil',
	'mexico',
	'argentina',
	'colombia',
	'nigeria',
	'kenya',
	'south africa',
	'egypt',
	'singapore',
	'japan',
	'china',
	'philippines',
	'vietnam',
	'indonesia',
	'malaysia',
	'israel',
	'uae',
	'dubai',
	// US states and metros, since "Remote - California" and "US-Remote, Chicago"
	// name a locale rather than the country. Not exhaustive by design — this is
	// a noise filter, and an unrecognised city still falls through to allowed.
	'california',
	'texas',
	'new york',
	'nyc',
	'washington',
	'massachusetts',
	'colorado',
	'illinois',
	'florida',
	'georgia',
	'oregon',
	'arizona',
	'utah',
	'north carolina',
	'virginia',
	'pennsylvania',
	'new jersey',
	'minnesota',
	'ohio',
	'michigan',
	'maryland',
	'san francisco',
	'seattle',
	'austin',
	'chicago',
	'boston',
	'denver',
	'atlanta',
	'los angeles',
	'toronto',
	'vancouver',
	'london',
	'berlin',
	'amsterdam',
	'dublin',
	'lisbon',
	'barcelona',
	'madrid',
	'paris',
	'warsaw',
	'sydney',
	'melbourne',
	'tokyo',
	'tel aviv',
];

/** "Remote" that is not actually remote to this search. */
const GEO_ONLY_DENY = [
	'us only',
	'usa only',
	'united states only',
	'us based only',
	'us residents only',
	'must reside in the united states',
	'emea only',
	'eu only',
	'uk only',
	'canada only',
];

/**
 * Lowercase and flatten punctuation so "(U.S. only)" and "US-only" both reduce
 * to the same haystack. Never used for YOE parsing — it eats the hyphen that
 * makes "0-2 years" a range.
 */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/u\.s\.a?\.?/g, 'us')
		.replace(/[\s\-_/(),.]+/g, ' ')
		.trim();
}

/** Whole-token phrase test, so "sr." cannot match inside an unrelated word. */
function containsPhrase(flat: string, phrase: string): boolean {
	return ` ${flat} `.includes(` ${normalize(phrase)} `);
}

/**
 * Title gate. The seniority denylist always applies; `config` layers the
 * per-search allow/deny on top when supplied.
 */
export function roleOk(title: string, config?: Pick<FilterConfig, 'titleAllow' | 'titleDeny'>): boolean {
	const flat = normalize(title);
	if (SENIORITY_DENY.some((word) => containsPhrase(flat, word))) return false;
	if (config === undefined) return true;
	// Whole-token, not substring: the search carries short keywords ("swe", "sde")
	// that otherwise match inside unrelated words — "Swedish Speaking" is not a
	// software role. Normalisation flattens punctuation first, so a single
	// "full stack" entry covers "Full-Stack" and "Full Stack" alike.
	if (config.titleDeny.some((word) => containsPhrase(flat, word))) return false;
	return config.titleAllow.length === 0 || config.titleAllow.some((word) => containsPhrase(flat, word));
}

/**
 * Location / work-authorization gate. Runs over a location string or a whole
 * JD — both carry the same disqualifiers.
 *
 * Order matters: a US-only or sponsorship clause is checked BEFORE the remote
 * shortcut, so "Remote (US only)" is rejected rather than waved through on the
 * word "remote".
 */
export function geoOk(text: string, config?: Pick<FilterConfig, 'locationAllow' | 'allowRemote'>): boolean {
	const flat = normalize(text);
	if (WORK_AUTH_DENY.some((phrase) => containsPhrase(flat, phrase))) return false;
	if (GEO_ONLY_DENY.some((phrase) => containsPhrase(flat, phrase))) return false;
	if (config === undefined) return true;

	const named = config.locationAllow.length === 0 || containsAny(text, config.locationAllow);
	if (named) return true;

	// "Remote" only counts when it is not bound to a region this search cannot
	// serve. Without this, `allowRemote` waved through "US-Remote, Chicago" and
	// "Portugal, Remote" on the bare word "remote".
	if (config.allowRemote && isRemote(text)) return !FOREIGN_REGION.some((region) => containsPhrase(flat, region));

	return false;
}

/** A range ("0-2 years", "1 to 3 yrs") — the LOW end is the requirement floor. */
const YOE_RANGE = /(\d{1,2})\s*(?:[-–—]|\s+to\s+)\s*(\d{1,2})\s*\+?\s*(year|yr|month|mo)s?\b/gi;

/** A lone figure ("2+ years", "minimum 3 yrs", "6 months"). */
const YOE_SINGLE = /(\d{1,2})\s*\+?\s*(year|yr|month|mo)s?\b/gi;

function toYears(value: number, unit: string): number {
	// Anything under a year is an entry-level ask, so it floors to 0.
	return unit.startsWith('mo') ? Math.floor(value / 12) : value;
}

/**
 * Minimum years of experience demanded by `text`, or null when it says nothing.
 *
 * Two rules, and they pull in opposite directions on purpose:
 *   - within one range, take the LOW end — "1-3 years" admits a 1-year candidate;
 *   - across separate mentions, take the HIGHEST floor — "5+ years overall,
 *     1+ years with Python" is a 5-year req, not a 1-year one.
 */
export function minYoe(text: string): number | null {
	const floors: number[] = [];
	const spans: Array<[number, number]> = [];

	for (const match of text.matchAll(YOE_RANGE)) {
		const start = match.index ?? 0;
		spans.push([start, start + match[0].length]);
		floors.push(toYears(Number(match[1]), match[3].toLowerCase()));
	}

	for (const match of text.matchAll(YOE_SINGLE)) {
		const start = match.index ?? 0;
		// Skip the tail of a range already counted — "0-2 years" must not also
		// register as a bare "2 years".
		if (spans.some(([from, to]) => start >= from && start < to)) continue;
		floors.push(toYears(Number(match[1]), match[2].toLowerCase()));
	}

	return floors.length === 0 ? null : Math.max(...floors);
}

/**
 * Experience gate. An unstated requirement passes — plenty of entry-level reqs
 * simply never name a number, and a missed job costs more than a skimmed one.
 */
export function yoeOk(text: string, maxYoe = 2): boolean {
	const floor = minYoe(text);
	return floor === null || floor <= maxYoe;
}
