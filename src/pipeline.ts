import { eligibleLocations, isFresh, isInternTitle, mentionsPpo, passesDetailFilters, roleOk, titleBoost, geoOk, minYoe, yoeVerdict, type FilterConfig } from './filters';
import type { Job, JobDetail } from './types';

/**
 * Stage-by-stage survivor counts for one batch of listed jobs. Cumulative: each
 * stage counts what is left after the previous one, so the numbers line up as a
 * funnel in `source_runs`.
 */
export interface LightCounts {
	title: number;
	location: number;
	fresh: number;
}

export interface LightResult {
	/** Jobs cleared for a JD fetch, with `location` narrowed to the eligible places. */
	shortlist: Job[];
	/** External ids rejected on the light payload, safe to mark seen immediately. */
	rejected: string[];
	counts: LightCounts;
}

/**
 * Light gate: title, then location, then freshness. Pure, no I/O.
 *
 * `location` on a shortlisted job is replaced by the places this search can
 * actually serve, so "Bengaluru, India; Lisbon, Portugal" goes downstream as
 * "Bengaluru, India" and the dedupe key and the message never mention Lisbon.
 */
export function lightGate(jobs: readonly Job[], config: FilterConfig, now: number): LightResult {
	const counts: LightCounts = { title: 0, location: 0, fresh: 0 };
	const shortlist: Job[] = [];
	const rejected: string[] = [];

	for (const job of jobs) {
		if (!roleOk(job.title, config)) {
			rejected.push(job.externalId);
			continue;
		}
		counts.title += 1;

		const places = eligibleLocations(job.location, config);
		if (places.length === 0) {
			rejected.push(job.externalId);
			continue;
		}
		counts.location += 1;

		if (!isFresh(job.postedAt, config, now)) {
			rejected.push(job.externalId);
			continue;
		}
		counts.fresh += 1;

		shortlist.push({ ...job, location: places.join('; ') });
	}

	return { shortlist, rejected, counts };
}

export type DetailRejection = 'description' | 'yoe' | 'unknown_yoe' | 'intern_no_ppo';

export type DetailOutcome = { ok: true; yoeMin: number | null } | { ok: false; reason: DetailRejection };

export interface DetailOptions {
	/** The `send_unknown_yoe` flag. */
	sendUnknownYoe: boolean;
	maxYoe?: number;
}

/**
 * Detail gate over a fetched JD. Pure, no I/O.
 *
 * A JD that names no experience number is NOT eligible by default: it is sent
 * only when `sendUnknownYoe` is on AND the title reads as entry-level.
 *
 * With `internRequiresPpo`, an internship passes only when its JD offers a PPO or
 * a conversion to full time. Once it does, a missing experience number is fine:
 * interns rarely state one, and the unknown-YOE block would drop every one.
 */
export function detailGate(detail: JobDetail, config: FilterConfig, options: DetailOptions): DetailOutcome {
	// Work-authorization and geo clauses live in the JD, not the location field.
	if (!passesDetailFilters(detail, config)) return { ok: false, reason: 'description' };
	if (!geoOk(detail.description)) return { ok: false, reason: 'description' };

	const intern = config.internRequiresPpo === true && isInternTitle(detail.title);
	if (intern && !mentionsPpo(detail.description)) return { ok: false, reason: 'intern_no_ppo' };

	// A source that already knows the number (some APIs report it) wins over the parse.
	const parsed = detail.yoeMin ?? minYoe(detail.description);
	const verdict = detail.yoeMin !== undefined && detail.yoeMin !== null ? (detail.yoeMin <= (options.maxYoe ?? 2) ? 'ok' : 'reject') : yoeVerdict(detail.description, options.maxYoe);

	if (verdict === 'reject') return { ok: false, reason: 'yoe' };
	if (verdict === 'unknown' && !intern && !(options.sendUnknownYoe && titleBoost(detail.title))) return { ok: false, reason: 'unknown_yoe' };
	return { ok: true, yoeMin: parsed };
}
