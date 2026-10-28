import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleIngest } from '../src/ingest';
import { resetJobs, stubTelegram, TEST_ENV, type BotCall } from './helpers';

let calls: BotCall[];

beforeEach(async () => {
	await resetJobs();
	calls = stubTelegram();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const post = (body: unknown, key: string | null = TEST_ENV.INGEST_KEY ?? ''): Request =>
	new Request('https://x/ingest', { method: 'POST', headers: key === null ? {} : { 'x-ingest-key': key }, body: typeof body === 'string' ? body : JSON.stringify(body) });

interface IngestBody {
	queued: number;
	duplicate: number;
	filtered: number;
	invalid: number;
	notified: number;
	results: Array<{ result: string; reason?: string }>;
}

async function ingest(body: unknown): Promise<IngestBody> {
	const response = await handleIngest(post(body), TEST_ENV);
	expect(response.status).toBe(200);
	return (await response.json()) as IngestBody;
}

const tweet = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	url: 'https://boards.greenhouse.io/acme/jobs/55?utm_source=twitter',
	title: 'We are hiring an AI Engineer',
	company: 'Acme',
	location: '',
	source: 'x',
	tweet_url: 'https://x.com/RohoolAgi/status/1',
	...over,
});

const polled = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	url: 'https://jobs.example.com/ml-1',
	title: 'ML Engineer',
	company: 'Beta',
	location: 'Pune, India',
	source: 'jobspy',
	description_snippet: 'Build models. 0-1 years of experience.',
	...over,
});

describe('POST /ingest access', () => {
	it('answers 401 without the key and 503 when the secret is unset', async () => {
		expect((await handleIngest(post(tweet(), null), TEST_ENV)).status).toBe(401);
		expect((await handleIngest(post(tweet(), 'wrong'), TEST_ENV)).status).toBe(401);
		expect((await handleIngest(post(tweet()), { ...TEST_ENV, INGEST_KEY: undefined })).status).toBe(503);
		expect(calls).toHaveLength(0);
	});

	it('rejects bad JSON, an empty array and an oversized batch', async () => {
		expect((await handleIngest(post('{nope'), TEST_ENV)).status).toBe(400);
		expect((await handleIngest(post([]), TEST_ENV)).status).toBe(400);
		expect((await handleIngest(post(Array.from({ length: 26 }, () => tweet())), TEST_ENV)).status).toBe(413);
	});
});

describe('POST /ingest queueing', () => {
	it('queues a tweet and announces it with Apply and Skip buttons', async () => {
		const body = await ingest(tweet());
		expect(body).toMatchObject({ queued: 1, duplicate: 0, filtered: 0, invalid: 0, notified: 1 });

		const row = await env.DB.prepare(`SELECT rowid AS id, status, source, sources, url_norm, tweet_url, notified FROM jobs`).first<Record<string, unknown>>();
		expect(row).toMatchObject({
			status: 'new',
			source: 'x',
			sources: 'x',
			url_norm: 'https://boards.greenhouse.io/acme/jobs/55',
			tweet_url: 'https://x.com/RohoolAgi/status/1',
			notified: 1,
		});

		expect(calls).toHaveLength(1);
		const message = calls[0]?.body as { text: string; reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
		expect(message.text).toContain('Acme');
		expect(message.text).toContain('Tweet');
		expect(message.reply_markup.inline_keyboard).toEqual([
			[
				{ text: '✅ Apply', callback_data: `a:${row?.id}` },
				{ text: '❌ Skip', callback_data: `s:${row?.id}` },
			],
		]);
	});

	it('accepts a single object, an array and { jobs: [] }', async () => {
		expect((await ingest(tweet({ url: 'https://a.com/1' }))).queued).toBe(1);
		expect((await ingest([tweet({ url: 'https://a.com/2', title: 'AI Engineer two' })])).queued).toBe(1);
		expect((await ingest({ jobs: [tweet({ url: 'https://a.com/3', title: 'AI Engineer three' })] })).queued).toBe(1);
	});

	it('marks a malformed item invalid without sinking the rest', async () => {
		const body = await ingest([tweet({ company: '' }), tweet({ url: 'ftp://nope' }), tweet({ source: 'Bad Source!' }), tweet({ url: 'https://a.com/ok' })]);
		expect(body).toMatchObject({ queued: 1, invalid: 3 });
		expect(body.results.map((entry) => entry.result)).toEqual(['invalid', 'invalid', 'invalid', 'queued']);
	});
});

describe('POST /ingest dedupe', () => {
	it('treats the same posting under another tracking suffix as a duplicate and records both sources', async () => {
		await ingest(tweet());
		calls.length = 0;

		const body = await ingest(polled({ url: 'http://www.boards.greenhouse.io/acme/jobs/55/?gh_src=li', title: 'AI Engineer', company: 'Acme', location: 'Pune, India' }));
		expect(body).toMatchObject({ queued: 0, duplicate: 1 });
		expect(calls).toHaveLength(0);

		const row = await env.DB.prepare(`SELECT sources FROM jobs`).first<{ sources: string }>();
		expect(row?.sources).toBe('x,jobspy');
	});

	it('merges the same role found at another url, with its place and source', async () => {
		await ingest(polled({ url: 'https://one.example.com/a', location: 'Pune, India' }));
		calls.length = 0;

		const body = await ingest(polled({ url: 'https://two.example.com/b', location: 'Mumbai, India', source: 'himalayas' }));
		expect(body.duplicate).toBe(1);
		expect(calls).toHaveLength(0);

		const row = await env.DB.prepare(`SELECT locations, sources FROM jobs`).first<{ locations: string; sources: string }>();
		expect(row).toEqual({ locations: 'Pune, India; Mumbai, India', sources: 'jobspy,himalayas' });
	});

	it('collapses duplicates inside one request', async () => {
		const body = await ingest([tweet(), tweet({ url: 'https://boards.greenhouse.io/acme/jobs/55?ref=li' })]);
		expect(body).toMatchObject({ queued: 1, duplicate: 1 });
		expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs`).first<{ n: number }>()).toEqual({ n: 1 });
	});
});

describe('POST /ingest gates for sources that are not trusted', () => {
	const reasons = async (item: Record<string, unknown>): Promise<string | undefined> => (await ingest(item)).results[0]?.reason;

	it('applies the title, place, YOE and intern rules', async () => {
		expect(await reasons(polled({ title: 'Backend Engineer' }))).toBe('title');
		expect(await reasons(polled({ title: 'Senior ML Engineer', url: 'https://e.com/1' }))).toBe('title');
		expect(await reasons(polled({ location: 'Remote (US only)', url: 'https://e.com/2' }))).toBe('location');
		expect(await reasons(polled({ description_snippet: '', url: 'https://e.com/3' }))).toBe('unknown_yoe');
		expect(await reasons(polled({ description_snippet: '6+ years of experience', url: 'https://e.com/4' }))).toBe('yoe');
		expect(await reasons(polled({ title: 'AI Engineer Intern', description_snippet: 'Build things.', url: 'https://e.com/5' }))).toBe('intern_no_ppo');
		expect(calls).toHaveLength(0);
	});

	it('lets a PPO internship and a known yoe_min through', async () => {
		const body = await ingest([
			polled({ title: 'AI Engineer Intern', description_snippet: 'Strong interns get a PPO.', url: 'https://e.com/6' }),
			polled({ url: 'https://e.com/7', title: 'LLM Engineer', description_snippet: '', yoe_min: 1 }),
		]);
		expect(body.queued).toBe(2);
	});

	it('does not gate a trusted source', async () => {
		expect((await ingest(tweet({ title: 'anything at all', location: 'Mars' }))).queued).toBe(1);
	});
});

describe('POST /ingest announcements', () => {
	it('sends a digest, 5 jobs a message with a button row per job, above 10 new jobs', async () => {
		const items = Array.from({ length: 12 }, (_, index) => tweet({ url: `https://a.com/job/${index}`, title: `AI Engineer ${index}`, company: `Co ${index}` }));
		const body = await ingest(items);
		expect(body).toMatchObject({ queued: 12, notified: 12 });

		expect(calls).toHaveLength(3);
		const rows = calls.map((call) => ((call.body as { reply_markup: { inline_keyboard: unknown[] } }).reply_markup.inline_keyboard.length));
		expect(rows).toEqual([5, 5, 2]);
	}, 20_000);
});

describe('POST /ingest from the X scraper', () => {
	// Copied from `python x_scraper.py --dry-run --fixture fixtures/sample_tweets.json`, including the
	// microsecond timestamps Python writes, so a change on either side breaks here first.
	const fromScraper = [
		{
			url: 'https://boards.greenhouse.io/acme/jobs/4455',
			title: "We're hiring an AI Engineer (0-2 yrs) at Acme! Remote India. Apply: #hiring",
			company: 'Acme',
			location: '',
			remote: false,
			source: 'x',
			posted_at: '2026-10-28T04:37:33.534586+00:00',
			description_snippet: "We're hiring an AI Engineer (0-2 yrs) at Acme! Remote India. Apply: #hiring",
			tweet_url: 'https://x.com/RohoolAgi/status/1850000000000000010',
		},
		{
			url: 'https://jobs.ashbyhq.com/gamma/1234abcd',
			title: 'Forward Deployed Engineer role open at Gamma. Details',
			company: 'Gamma',
			location: '',
			remote: false,
			source: 'x',
			posted_at: '2026-10-28T03:37:33.534586+00:00',
			description_snippet: 'Forward Deployed Engineer role open at Gamma. Details:',
			tweet_url: 'https://x.com/Ajay_2512x/status/1850000000000000011',
		},
		{
			url: 'https://careers.delta-labs.io/jobs/ml-intern',
			title: 'ML Engineer intern (PPO on performance) at Delta Labs, apply',
			company: 'Delta Labs',
			location: '',
			remote: false,
			source: 'x',
			posted_at: '2026-10-27T23:37:33.534586+00:00',
			description_snippet: 'ML Engineer intern (PPO on performance) at Delta Labs, apply',
			tweet_url: 'https://x.com/Ajay_2512x/status/1850000000000000014',
		},
	];

	it('accepts every item, announces each with buttons, and a rerun is all duplicates', async () => {
		const first = await ingest(fromScraper);
		expect(first).toMatchObject({ queued: 3, duplicate: 0, filtered: 0, invalid: 0, notified: 3 });
		expect(calls).toHaveLength(3);
		expect(calls.every((call) => 'reply_markup' in call.body)).toBe(true);

		// The scraper retries a failed run with the same tweets: that must be harmless.
		calls.length = 0;
		const again = await ingest(fromScraper);
		expect(again).toMatchObject({ queued: 0, duplicate: 3 });
		expect(calls).toHaveLength(0);

		const stored = await env.DB.prepare(`SELECT posted_at, tweet_url FROM jobs ORDER BY rowid`).all<{ posted_at: string; tweet_url: string }>();
		expect(stored.results[0]?.posted_at).toBe('2026-10-28T04:37:33.534Z');
		expect(stored.results.map((row) => row.tweet_url)).toEqual(fromScraper.map((item) => item.tweet_url));
	});
});

describe('POST /ingest when the database fails', () => {
	it('answers 500 with the reason, not a bare message, and does not announce anything', async () => {
		const broken = {
			...TEST_ENV,
			DB: {
				prepare(): never {
					throw new Error('D1_ERROR: boom for the test');
				},
				batch(): never {
					throw new Error('D1_ERROR: boom for the test');
				},
			} as unknown as typeof TEST_ENV.DB,
		};
		const response = await handleIngest(post(tweet()), broken);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'ingest failed', detail: 'Error: D1_ERROR: boom for the test' });
		expect(calls).toHaveLength(0);
	});
});

describe('POST /ingest from the LinkedIn scraper', () => {
	// Copied from `python linkedin_scraper.py --dry-run --fixture fixtures/sample_jobs.json`, so a change on
	// either side breaks here first. LinkedIn is not a trusted source: every item goes through the same gates
	// as a polled job.
	const fromScraper = [
  {
    "url": "https://www.linkedin.com/jobs/view/4000000001",
    "title": "AI Engineer",
    "company": "Acme Labs",
    "location": "Bengaluru, Karnataka, India",
    "remote": false,
    "source": "linkedin",
    "description_snippet": "We want 0-2 years of experience with Python. Strong candidates may convert to a full time role. | You will build and evaluate LLM applications. You will work with a small team. Strong candidates may convert to a full time role.",
    "posted_at": "2026-10-27T00:00:00+00:00",
    "yoe_min": 0
  },
  {
    "url": "https://www.linkedin.com/jobs/view/4000000002",
    "title": "LLM Engineer",
    "company": "Beta AI",
    "location": "Hyderabad, Telangana, India",
    "remote": false,
    "source": "linkedin",
    "description_snippet": "Requires 5+ years of experience shipping ML systems. Experience with Kubernetes is a plus. | Own our LLM platform. Experience with Kubernetes is a plus.",
    "posted_at": "2026-10-26T00:00:00+00:00",
    "yoe_min": 5
  },
  {
    "url": "https://www.linkedin.com/jobs/view/4000000003",
    "title": "Forward Deployed Engineer",
    "company": "Gamma",
    "location": "Remote",
    "remote": true,
    "source": "linkedin",
    "description_snippet": "You must be authorized to work in the United States. We do not offer visa sponsorship. 1-3 years of experience. | Work with customers on site or remotely. You must be authorized to work in the United States. We do not offer visa sponsorship.",
    "posted_at": "2026-10-28T00:00:00+00:00",
    "yoe_min": 1
  },
  {
    "url": "https://www.linkedin.com/jobs/view/4000000004",
    "title": "Machine Learning Intern",
    "company": "Delta Research",
    "location": "Mumbai, Maharashtra, India",
    "remote": false,
    "source": "linkedin",
    "description_snippet": "Outstanding interns receive a PPO. No prior experience needed. | Six month internship working on retrieval models. Outstanding interns receive a PPO. No prior experience needed.",
    "posted_at": "2026-10-28T00:00:00+00:00"
  }
];

	it('queues the entry-level jobs and rejects the ones this search is not for, with the reason', async () => {
		const body = await ingest(fromScraper);
		expect(body).toMatchObject({ queued: 2, filtered: 2, duplicate: 0, invalid: 0 });
		expect(body.results.map((entry) => entry.result + (entry.reason ? `:${entry.reason}` : ''))).toEqual([
			'queued', // AI Engineer, 0 years, Bengaluru
			'filtered:yoe', // LLM Engineer asking for 5+ years
			'filtered:description', // Forward Deployed Engineer that needs US work authorization
			'queued', // Machine Learning Intern with a PPO and no stated number
		]);
	});

	it('stores the canonical url, the source and the date, and a rerun is all duplicates', async () => {
		await ingest(fromScraper);
		const rows = await env.DB.prepare(`SELECT url_norm, source, posted_at FROM jobs ORDER BY rowid`).all<{ url_norm: string; source: string; posted_at: string }>();
		expect(rows.results).toEqual([
			{ url_norm: 'https://www.linkedin.com/jobs/view/4000000001', source: 'linkedin', posted_at: '2026-10-27T00:00:00.000Z' },
			{ url_norm: 'https://www.linkedin.com/jobs/view/4000000004', source: 'linkedin', posted_at: '2026-10-28T00:00:00.000Z' },
		]);

		calls.length = 0;
		const again = await ingest(fromScraper);
		expect(again.queued).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it('sees the same posting under a different tracking url as a duplicate', async () => {
		await ingest(fromScraper);
		const body = await ingest([{ ...fromScraper[0], url: 'https://in.linkedin.com/jobs/view/ai-engineer-at-acme-4000000001?refId=zzz&trackingId=qqq' }]);
		expect(body).toMatchObject({ queued: 0, duplicate: 1 });
	});
});
