import type { FilterConfig } from './filters';

/** Companies polled per tick. Bounded by the 50-subrequest cap. */
export const COMPANIES_PER_TICK = 8;

/** Concurrent outbound connections allowed on Workers. */
export const MAX_CONCURRENCY = 6;

/** Free-plan subrequest cap per invocation, minus headroom for Telegram sends. */
export const SUBREQUEST_CAP = 50;

/** Upper bound on phase-2 JD fetches in one tick. */
export const MAX_DETAILS_PER_TICK = 20;

/** Jobs per Telegram message. Telegram caps a message at 4096 chars. */
export const JOBS_PER_MESSAGE = 5;

/**
 * TODO: tune to your search. Everything here is a lowercase substring test.
 * Pure config — `filters.ts` does the matching and stays I/O-free.
 */
export const FILTERS: FilterConfig = {
	// Matched whole-token against a punctuation-flattened title, so "front end"
	// also covers "Front-End" and the one-word spellings need their own entry.
	titleAllow: [
		'frontend',
		'front end',
		'backend',
		'back end',
		'fullstack',
		'full stack',
		'react',
		'javascript',
		'software engineer',
		'software development engineer',
		'swe',
		'sde',
		'staff engineer',
		// Entry-level wording that no keyword above would catch.
		'new grad',
		'university grad',
	],
	titleDeny: ['senior', 'principal', 'director', 'manager', 'lead', 'intern', 'sales', 'recruiter'],
	locationAllow: ['india', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'delhi', 'gurgaon', 'noida', 'mumbai', 'chennai'],
	allowRemote: true,
	maxAgeDays: 30,
	descriptionAllow: [],
	descriptionDeny: ['security clearance', 'us citizen'],
};
