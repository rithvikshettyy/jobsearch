/**
 * Manual semaphore. Workers allows 6 concurrent outbound connections; going over
 * makes the extra fetches queue inside the runtime and eat wall-clock time.
 */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: Array<() => void> = [];

	const release = (): void => {
		active -= 1;
		const next = waiting.shift();
		if (next) next();
	};

	return async function limit<T>(fn: () => Promise<T>): Promise<T> {
		if (active >= concurrency) {
			await new Promise<void>((resolve) => waiting.push(resolve));
		}
		active += 1;
		try {
			return await fn();
		} finally {
			release();
		}
	};
}

/**
 * Hard cap on external subrequests for one invocation. Free plan allows 50.
 * Callers `take()` before spending; a false return means "stop, do it next tick".
 */
export class SubrequestBudget {
	private used = 0;

	constructor(private readonly cap: number) {}

	take(n = 1): boolean {
		if (this.used + n > this.cap) return false;
		this.used += n;
		return true;
	}

	get spent(): number {
		return this.used;
	}

	get left(): number {
		return this.cap - this.used;
	}
}
