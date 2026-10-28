import { describe, expect, it } from 'vitest';
import { FILTERS } from '../src/config';
import { detailGate } from '../src/pipeline';
import { geoOk, roleOk, type FilterConfig } from '../src/filters';
import type { JobDetail } from '../src/types';

const config: FilterConfig = {
	titleAllow: ['ai engineer'],
	titleDeny: [],
	locationAllow: [],
	allowRemote: true,
	maxAgeDays: 0,
	descriptionAllow: [],
	descriptionDeny: [],
	internRequiresPpo: true,
};

function detail(title: string, description: string): JobDetail {
	return {
		externalId: '1',
		title,
		company: 'Acme',
		location: 'Pune, India',
		url: 'https://example.com/1',
		postedAt: null,
		description,
	} as JobDetail;
}

describe('detailGate with internRequiresPpo', () => {
	const options = { sendUnknownYoe: false };

	it('drops an internship with no PPO wording', () => {
		const outcome = detailGate(detail('AI Engineer Intern', 'Build models for 3 months.'), config, options);
		expect(outcome).toEqual({ ok: false, reason: 'intern_no_ppo' });
	});

	it('keeps an internship that offers a PPO, even with no experience number', () => {
		const outcome = detailGate(detail('AI Engineer Intern', 'Build models. Strong interns get a PPO.'), config, options);
		expect(outcome.ok).toBe(true);
	});

	it('does not touch a full-time role', () => {
		expect(detailGate(detail('AI Engineer', 'Build models. 0-1 years of experience.'), config, options).ok).toBe(true);
	});

	it('still blocks a full-time role with no experience number', () => {
		expect(detailGate(detail('AI Engineer', 'Build models.'), config, options)).toEqual({ ok: false, reason: 'unknown_yoe' });
	});

	it('still rejects a PPO internship that asks for 5 years', () => {
		expect(detailGate(detail('AI Engineer Intern', 'PPO available. 5+ years of experience.'), config, options)).toEqual({ ok: false, reason: 'yoe' });
	});

	it('is off when the flag is unset', () => {
		const outcome = detailGate(detail('AI Engineer Intern', 'Build models. 0-1 years.'), { ...config, internRequiresPpo: undefined }, options);
		expect(outcome.ok).toBe(true);
	});
});

describe('the real FILTERS search', () => {
	it('accepts live titles from the AI-company boards', () => {
		for (const title of [
			'Forward Deployed Engineer',
			'Forward Deployed Software Engineer - SF',
			'Forward-Deployed AI Engineer',
			'AI Engineer - FDE (Forward Deployed Engineer)',
			'Applied AI Engineer, Startups (Codex)',
			'Software Engineer, ML Infrastructure',
			'Full Stack LLM Engineer',
			'Machine Learning Engineer, Radar',
		]) {
			expect(roleOk(title, FILTERS), title).toBe(true);
		}
	});

	it('rejects titles that only borrow the words', () => {
		for (const title of [
			'Deployment Strategist - Germany Forward Deployed',
			'Forward Deployed Researcher - Data as a Service',
			'Backend Engineer',
			'Software Engineering Intern',
			'Senior AI Engineer',
		]) {
			expect(roleOk(title, FILTERS), title).toBe(false);
		}
	});

	it('accepts any country but not a US-only clause', () => {
		expect(geoOk('Seoul, South Korea', FILTERS)).toBe(true);
		expect(geoOk('Remote', FILTERS)).toBe(true);
		expect(geoOk('Remote (US only)', FILTERS)).toBe(false);
	});
});
