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
