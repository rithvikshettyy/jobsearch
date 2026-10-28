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
	/**
	 * A "remote" location only counts when it names one of these ("Remote - APAC",
	 * "Worldwide"). Default: `REMOTE_OPEN`. Bare "Remote" is not enough.
	 */
	remoteOpen?: string[];
	/**
	 * Accept a bare "Remote" with no region at all. Default false: a US company's
	 * plain "Remote" almost always means US-only.
	 */
	allowBareRemote?: boolean;
	/**
	 * Accept a place in any country. The US-only style clauses and the work
	 * authorization clauses still reject. Default false.
	 */
	allowInternational?: boolean;
	/**
	 * Let an entry-level title ("Intern", "Graduate", "Junior") with a technical word
	 * through even when `titleAllow` has no match. Default true. Off when the search
	 * names exact roles, otherwise "Software Engineering Intern" slips past them.
	 */
	entryBoostAllow?: boolean;
	/**
	 * An internship title passes only when its JD offers a PPO or a conversion to
	 * full time. Default false.
	 */
	internRequiresPpo?: boolean;
}

/** Regions a "remote" posting may name and still be open to a candidate in India. */
export const REMOTE_OPEN = ['india', 'apac', 'asia pacific', 'asia', 'worldwide', 'anywhere', 'global', 'globally'];

type GeoConfig = Pick<FilterConfig, 'locationAllow' | 'allowRemote' | 'remoteOpen' | 'allowBareRemote' | 'allowInternational'>;

const REMOTE_HINTS = ['remote', 'anywhere', 'distributed', 'work from home'];

function containsAny(haystack: string, needles: string[]): boolean {
	const lowered = haystack.toLowerCase();
	return needles.some((needle) => lowered.includes(needle.toLowerCase()));
}

export function matchesTitle(title: string, config: FilterConfig): boolean {
	return roleOk(title, config);
}

export function isRemote(location: string): boolean {
	return containsAny(location, REMOTE_HINTS);
}

export function matchesLocation(location: string, config: FilterConfig): boolean {
	return geoOk(location, config);
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
 * Bands that explicitly mark the FIRST rung, even when the title also carries a
 * word the seniority list rejects. "Technical Lead L1" is an entry role at the
 * companies that use this scheme, so the L1 tag has to outrank the word "lead".
 */
const JUNIOR_OVERRIDE = ['l1', 'level 1', 'i1'];

/**
 * Hard title exclude, run BEFORE any allowlist or YOE parsing. Case-insensitive,
 * with a hand-rolled right boundary so "sr." and "SRE" are told apart and
 * "Leadership Program" is not "lead".
 *
 * Two tiers: STRICT markers are never waived, SOFT ones can be by an explicit
 * L1 band ("Technical Lead L1").
 */
const HARD_EXCLUDE_STRICT = /\b(?:staff|senior|sr\.?|principal|director|architect|ii|iii|iv|l4|l5|sde[ -]?[23]|intermediate|(?:engineer|developer|scientist) ?[2-9])(?![a-z0-9])/i;
const HARD_EXCLUDE_SOFT = /\b(?:lead|manager|head)(?![a-z0-9])/i;

/** Titles that read as entry-level. Boosts the allowlist and gates unknown YOE. */
const TITLE_INCLUDE = /\b(?:intern|internship|fresher|graduate|new grad|entry|junior|jr\.?|trainee|associate|sde[ -]?1|engineer i)(?![a-z0-9])/i;

/** A boosted title must still name a technical role: "Industrial Trainee" is not one. */
const TECH_WORD =
	/\b(?:engineer|engineering|developer|software|sde|swe|programmer|ml|ai|data|python|react|frontend|front end|backend|back end|full ?stack|machine learning)(?![a-z0-9])/i;

/** True when the title reads as entry-level (intern, fresher, junior, SDE 1 ...). */
export function titleBoost(title: string): boolean {
	return TITLE_INCLUDE.test(title);
}

/**
 * Title gate. The hard exclude always applies and runs first; `config` layers
 * the per-search allow/deny on top when supplied.
 */
export function roleOk(title: string, config?: Pick<FilterConfig, 'titleAllow' | 'titleDeny' | 'entryBoostAllow'>): boolean {
	const flat = normalize(title);
	// An explicit L1 band overrides "lead" and the denylists, but never the
	// strict level markers and never the allowlist, so a non-engineering
	// "Support L1" still has to match a role keyword.
	const junior = JUNIOR_OVERRIDE.some((tag) => containsPhrase(flat, tag));
	if (HARD_EXCLUDE_STRICT.test(title)) return false;
	if (!junior && HARD_EXCLUDE_SOFT.test(title)) return false;
	if (!junior && SENIORITY_DENY.some((word) => containsPhrase(flat, word))) return false;
	if (config === undefined) return true;
	// Whole-token, not substring: the search carries short keywords ("swe", "sde")
	// that otherwise match inside unrelated words — "Swedish Speaking" is not a
	// software role. Normalisation flattens punctuation first, so a single
	// "full stack" entry covers "Full-Stack" and "Full Stack" alike.
	if (!junior && config.titleDeny.some((word) => containsPhrase(flat, word))) return false;
	if (config.titleAllow.length === 0) return true;
	if (config.titleAllow.some((word) => containsPhrase(flat, word))) return true;
	if (config.entryBoostAllow === false) return false;
	return titleBoost(title) && TECH_WORD.test(title);
}

/** "Intern", "Interns", "Internship", but not "Internal Tools Engineer". */
const INTERN_TITLE = /\b(?:intern|interns|internship)(?![a-z0-9])/i;

/** A PPO, a pre-placement offer, or a stated conversion to a full-time role. */
const PPO_TEXT =
	/\b(?:ppo|pre[\s-]?placement\s+offer|return\s+offer|(?:convert(?:ed|ible|s)?|conversion)\s+(?:in)?to\s+(?:a\s+)?(?:full[\s-]?time|permanent)|full[\s-]?time\s+(?:conversion|offer|employment|role\s+(?:after|upon)))(?![a-z0-9])/i;

export function isInternTitle(title: string): boolean {
	return INTERN_TITLE.test(title);
}

export function mentionsPpo(text: string): boolean {
	return PPO_TEXT.test(text);
}

/**
 * One posting often carries several places: Greenhouse joins them with ";"
 * ("Bengaluru, India; Lisbon, Portugal"). Commas stay put, they separate a
 * city from its country.
 */
export function splitLocations(text: string): string[] {
	return text
		.split(/\s*(?:;|\||\n|\s\/\s|\sor\s)\s*/i)
		.map((part) => part.trim())
		.filter((part) => part !== '');
}

/** One place on its own. Whole-token matching, so "Indiana" is not "India". */
function placeOk(part: string, config: GeoConfig): boolean {
	const flat = normalize(part);
	if (GEO_ONLY_DENY.some((phrase) => containsPhrase(flat, phrase))) return false;
	if (config.allowInternational === true) return true;
	if (config.locationAllow.length === 0) return true;
	if (config.locationAllow.some((place) => containsPhrase(flat, place))) return true;
	if (!config.allowRemote) return false;

	// "Worldwide" and "Anywhere" are answers on their own, a bare "Remote" is not.
	const open = config.remoteOpen ?? REMOTE_OPEN;
	if (open.some((marker) => containsPhrase(flat, marker))) return true;
	// "Remote - Portugal" and "US-Remote" name a region this search cannot serve.
	if (config.allowBareRemote === true && isRemote(part)) return !FOREIGN_REGION.some((region) => containsPhrase(flat, region));
	return false;
}

/**
 * The places of `text` this search can serve. Empty = the posting is out.
 * A multi-location posting passes on ANY one eligible place, and callers store
 * only these so a message never advertises Lisbon.
 */
export function eligibleLocations(text: string, config: GeoConfig): string[] {
	const flat = normalize(text);
	if (WORK_AUTH_DENY.some((phrase) => containsPhrase(flat, phrase))) return [];
	return splitLocations(text).filter((part) => placeOk(part, config));
}

/**
 * Location / work-authorization gate. Runs over a location string or a whole
 * JD — both carry the same disqualifiers.
 *
 * Without `config` it applies only the work-authorization and US-only clauses
 * (the JD path). With `config`, `text` is split into places and one eligible
 * place is enough, see `eligibleLocations`. A US-only clause on a place is
 * checked before the remote shortcut, so "Remote (US only)" never passes.
 */
export function geoOk(text: string, config?: GeoConfig): boolean {
	if (config === undefined) {
		const flat = normalize(text);
		if (WORK_AUTH_DENY.some((phrase) => containsPhrase(flat, phrase))) return false;
		return !GEO_ONLY_DENY.some((phrase) => containsPhrase(flat, phrase));
	}
	return eligibleLocations(text, config).length > 0;
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

/** What the JD says about experience, for the three-way gate in the pipeline. */
export type YoeVerdict = 'ok' | 'unknown' | 'reject';

export function yoeVerdict(text: string, maxYoe = 2): YoeVerdict {
	const floor = minYoe(text);
	if (floor === null) return 'unknown';
	return floor <= maxYoe ? 'ok' : 'reject';
}
