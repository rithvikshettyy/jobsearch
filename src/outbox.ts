import { DIGEST_THRESHOLD, JOBS_PER_MESSAGE } from './config';
import type { SubrequestBudget } from './limit';
import { sendBatch, type NotifyJob } from './notify';
import { logError, markNotified, unnotified } from './store';
import type { Env } from './types';

/** Rows pulled from the outbox in one push, on top of whatever the caller just found. */
export const MAX_NOTIFY_PER_PUSH = 20;

/**
 * Drain the outbox. One subrequest per Telegram message, and a row flips to
 * notified only once Telegram has accepted it: a failed message stays at
 * `notified = 0` for the next tick.
 *
 * Shared by the cron tick and POST /ingest, so a job is announced the same way
 * whichever door it came in through.
 */
export async function pushOutbox(env: Env, budget: SubrequestBudget): Promise<{ notified: number; errors: number }> {
	// Worst case is one message per job, so this can never overspend the budget.
	const capacity = Math.min(MAX_NOTIFY_PER_PUSH, budget.left);
	if (capacity <= 0) return { notified: 0, errors: 0 };

	const rows = await unnotified(env, capacity);
	if (rows.length === 0) return { notified: 0, errors: 0 };

	const entries: NotifyJob[] = rows.map((row) => ({
		id: row.id,
		hash: row.hash,
		job: row.job,
		yoeMin: row.yoeMin,
		sources: row.sources,
		tweetUrl: row.tweetUrl,
	}));

	const messages = entries.length <= DIGEST_THRESHOLD ? entries.length : Math.ceil(entries.length / JOBS_PER_MESSAGE);
	if (!budget.take(messages)) return { notified: 0, errors: 0 };

	const result = await sendBatch(env, entries);
	await markNotified(env, result.sent);

	let errors = 0;
	if (result.failed.length > 0) {
		errors += 1;
		await logError(env, null, `telegram send failed for ${result.failed.length} job(s)`, 'notify');
	}
	return { notified: result.sent.length, errors };
}
