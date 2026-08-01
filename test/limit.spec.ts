import { describe, expect, it } from 'vitest';
import { createLimiter, SubrequestBudget } from '../src/limit';

describe('createLimiter', () => {
	it('never exceeds the concurrency cap', async () => {
		const limit = createLimiter(6);
		let active = 0;
		let peak = 0;

		await Promise.all(
			Array.from({ length: 25 }, () =>
				limit(async () => {
					active += 1;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 1));
					active -= 1;
				}),
			),
		);

		expect(peak).toBeLessThanOrEqual(6);
	});

	it('releases a slot when a task throws', async () => {
		const limit = createLimiter(1);
		await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
		await expect(limit(() => Promise.resolve('ok'))).resolves.toBe('ok');
	});
});

describe('SubrequestBudget', () => {
	it('allows spending up to the cap', () => {
		const budget = new SubrequestBudget(50);
		expect(budget.take(8)).toBe(true);
		expect(budget.take(42)).toBe(true);
		expect(budget.spent).toBe(50);
		expect(budget.left).toBe(0);
	});

	it('refuses a batch that would exceed the cap and spends nothing', () => {
		const budget = new SubrequestBudget(10);
		expect(budget.take(9)).toBe(true);
		expect(budget.take(2)).toBe(false);
		expect(budget.spent).toBe(9);
	});
});
