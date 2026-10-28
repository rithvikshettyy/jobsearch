import type { FilterConfig } from './filters';

/**
 * Companies polled per tick. The 50-subrequest cap would allow more, but CPU is the
 * binding limit: prod showed ~half of ticks dying at the 10ms cap with 8. At a
 * 2-minute cron this still polls 64 boards well inside 6h (180 ticks x 3 = 540 polls).
 */
export const COMPANIES_PER_TICK = 3;

/** Concurrent outbound connections allowed on Workers. */
export const MAX_CONCURRENCY = 6;

/** Free-plan subrequest cap per invocation, minus headroom for Telegram sends. */
export const SUBREQUEST_CAP = 50;

/** Upper bound on phase-2 JD fetches in one tick. */
export const MAX_DETAILS_PER_TICK = 20;

/** Jobs per Telegram message. Telegram caps a message at 4096 chars. */
export const JOBS_PER_MESSAGE = 5;

/**
 * At most this many new jobs in one push go out as one message each, with their own
 * Apply and Skip buttons. More than this becomes a digest: JOBS_PER_MESSAGE per
 * message, a button row per job.
 */
export const DIGEST_THRESHOLD = 10;

/** Gap between two Telegram sends in one push. Telegram allows about 1 message a second per chat. */
export const SEND_PACE_MS = 1100;

/** Jobs accepted by one POST /ingest. Small on purpose: D1 allows 50 queries per invocation on the free plan. */
export const MAX_INGEST_ITEMS = 25;

/**
 * Ingest sources whose items skip the title, location and JD gates. A tweet from an
 * account the user chose to follow has no structured title to filter on.
 */
export const TRUSTED_INGEST_SOURCES: readonly string[] = ['x'];

/**
 * TODO: tune to your search. Everything here is a lowercase substring test.
 * Pure config — `filters.ts` does the matching and stays I/O-free.
 */
export const FILTERS: FilterConfig = {
	// Matched whole-token against a punctuation-flattened title, so "front end"
	// also covers "Front-End" and the one-word spellings need their own entry.
	titleAllow: [
		// Forward deployed engineer, AI. "forward deployed" covers "Forward Deployed
		// AI Engineer" and the bare "FDE" abbreviation is whole-token matched.
		'forward deployed',
		'fde',
		// AI engineer. "AI/ML Engineer" flattens to "ai ml engineer".
		'ai engineer',
		'artificial intelligence engineer',
		'ai ml engineer',
		'ml ai engineer',
		// ML engineer, including the "Software Engineer, <field>" word order.
		'ml engineer',
		'machine learning engineer',
		'software engineer machine learning',
		'software engineer ml',
		'software engineer ai',
		// LLM engineer.
		'llm engineer',
		'software engineer llm',
	],
	// 'strategist' and 'researcher' because "forward deployed" also appears in Palantir's
	// "Deployment Strategist - Germany Forward Deployed" and "Forward Deployed Researcher".
	titleDeny: ['senior', 'principal', 'director', 'manager', 'lead', 'sales', 'recruiter', 'strategist', 'researcher'],
	// Whole-token phrases, so "Indiana" is not "india". Greenhouse joins several
	// places with ";" and `eligibleLocations` tests each one on its own.
	// Unused while `allowInternational` is on; kept as the home cities for when it is off.
	locationAllow: [
		'india',
		'bengaluru',
		'bangalore',
		'mumbai',
		'navi mumbai',
		'hyderabad',
		'delhi',
		'delhi ncr',
		'ncr',
		'gurugram',
		'gurgaon',
		'noida',
		'thane',
	],
	allowRemote: true,
	// Any country, remote or on-site. US-only clauses and work-authorization
	// clauses (citizen, visa, right to work) still reject, so this does not turn
	// into every role in the world that you could not legally take.
	allowInternational: true,
	allowBareRemote: true,
	// The search names exact roles, so entry-level wording alone is not enough.
	entryBoostAllow: false,
	// Full time, or an internship that converts (PPO). Plain internships are dropped.
	internRequiresPpo: true,
	maxAgeDays: 30,
	descriptionAllow: [],
	descriptionDeny: ['security clearance', 'us citizen'],
};

/**
 * Default for the `send_unknown_yoe` flag: a JD that names no experience number
 * is NOT sent. When true, it is sent only if the title reads as entry-level
 * (intern, fresher, junior ...). Override with the SEND_UNKNOWN_YOE env var.
 */
export const SEND_UNKNOWN_YOE = false;

/** A board that answers 404 this many polls in a row is switched off (`active = 0`) and the switch-off is logged. */
export const AUTO_DISABLE_404S = 5;

/** Same company + normalised title inside this window is one job, locations merged. */
export const DEDUPE_WINDOW_DAYS = 14;

/** A source_runs row older than this is pruned. */
export const SOURCE_RUNS_KEEP_DAYS = 14;
