export type SourceId = 'greenhouse' | 'lever' | 'ashby' | 'remotive' | 'remoteok';

export interface Env {
	DB: D1Database;
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_CHAT_ID: string;
	/** Optional. When set, POST /run requires this value in the `x-admin-token` header. */
	ADMIN_TOKEN?: string;
}

export interface Company {
	id: number;
	name: string;
	source: SourceId;
	/** Board slug/token on the ATS, e.g. "stripe" in boards.greenhouse.io/stripe. */
	board: string;
	/** Priority band, 1 = highest. Seeded rows default to 2. */
	tier: number;
}

/** Phase-1 shape. Light endpoints only — no description body. */
export interface Job {
	externalId: string;
	company: string;
	title: string;
	location: string;
	url: string;
	/** ISO-8601, or null when the board does not expose a date. */
	postedAt: string | null;
}

/** Phase-2 shape. Only ever built for ids absent from `seen_postings`. */
export interface JobDetail extends Job {
	description: string;
	/**
	 * Minimum years of experience, parsed from `description`. Optional because no
	 * ATS reports it — a source module leaves it unset and it stays null in D1
	 * until something downstream parses the JD.
	 */
	yoeMin?: number | null;
}

export interface Source {
	/**
	 * Phase 1. MUST cost exactly 1 subrequest — the orchestrator's budget math
	 * assumes it, and there is no retry on a cron trigger.
	 */
	fetchJobs(company: Company): Promise<Job[]>;
	/** Phase 2. Called only with jobs whose ids are new. */
	fetchDetails(company: Company, jobs: Job[]): Promise<JobDetail[]>;
	/** Subrequests `fetchDetails` spends on `n` jobs. */
	detailCost(n: number): number;
}

export interface TickResult {
	companies: string[];
	polled: number;
	newIds: number;
	detailed: number;
	notified: number;
	errors: number;
	subrequests: number;
}
