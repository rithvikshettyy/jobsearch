# job-bot

A Cloudflare Worker that finds AI engineering jobs and asks you before anything else
happens. It polls job boards and role searches on a cron, filters them to the roles you
want (forward deployed, AI, ML and LLM engineer), and sends each match to a Telegram
chat with **Apply** and **Skip** buttons. Your tap is saved in D1 as the job's status.
Nothing is applied to without an Apply tap.

It runs on Cloudflare's free plan: a Worker for the logic, D1 for state, Cron Triggers
for the schedule. No server, no queue.

```
 cron */2           POST /ingest                       Telegram button tap
    |                    ^                                     |
    v                    | (X scraper, other tools)            v
┌──────────┐      ┌──────┴───────┐                      ┌─────────────┐
│ runTick  │─────▶│   filters    │─────▶ D1 jobs ─────▶ │  Telegram   │
│ 3 boards │      │ + dedupe     │      (the queue)     │ Apply / Skip│
└────┬─────┘      └──────────────┘          ^           └──────┬──────┘
     │ phase 1: light list                  │                  │
     │ phase 2: JD for unseen ids           │   POST /tg-webhook
     v                                      └──────────────────┘
 boards and role searches            GET /queue?status=approved  ──▶  your applier
```

| Piece | Where | What it does |
| --- | --- | --- |
| Worker | [`src/`](src/) | Polls, filters, dedupes, queues, sends, handles taps |
| X scraper | [`x-scraper/`](x-scraper/) | Reads job tweets from chosen accounts and posts them to `/ingest` |
| LinkedIn reader | [`linkedin-scraper/`](linkedin-scraper/) | Optional. Reads LinkedIn listings with a signed-in session, read-only. Read its README first |
| Ops guide | [`SETUP.md`](SETUP.md) | Secrets, the `setWebhook` call, every endpoint, board discovery |
| Contributor notes | [`CLAUDE.md`](CLAUDE.md) | The hard constraints, in the order they bite |

## What it searches for

The search lives in `FILTERS` in [`src/config.ts`](src/config.ts), nowhere else:

- **Roles:** forward deployed engineer (AI), AI engineer, ML engineer, LLM engineer, and
  their usual spellings (`AI/ML Engineer`, `Software Engineer, ML`).
- **Places:** any country, remote or on site. US-only clauses and work-authorization
  clauses (citizen, visa, right to work) still reject, so you are not sent roles you
  cannot legally take. Set `allowInternational` to `false` to fall back to the India
  city list in the same file.
- **Types:** full time, or an internship whose description offers a PPO or a
  conversion to full time. A plain internship is dropped.

## Why it is built this way

The free plan gives each invocation **10ms of CPU, 50 subrequests, and 6 concurrent
connections**, and Cron Triggers never retry. D1's free tier also allows only **100,000
rows written and 5 million rows read per day**. Almost every decision here falls out of
those limits.

**Two-phase fetch.** Phase 1 polls a light endpoint per company and diffs the ids against
D1. Only ids never seen before get a phase-2 fetch for the full description. A naive
poller re-reads every description on every tick and blows the subrequest budget within a
handful of companies.

**Least-recently-polled sharding.** There are far more boards than fit in one invocation.
Each tick takes the 3 active companies with the oldest `last_polled_at` (never-polled
first) and stamps them before polling. Every board is reached once before any is reached
twice, adding or removing boards cannot skip anyone, and a tick that dies half way does
not re-poll the same boards forever. Three per tick, not eight, because CPU is the
binding limit: a large board list (Databricks has about 900 postings) can take most of
10ms to parse on its own.

**Dedupe in layers.** `seen_postings` tracks every external id ever observed. Then three
keys decide whether a job is new: the row key `sha256(company|title|location)`, a fuzzy
key `sha256(company|title)` that merges the same role across locations and boards for 14
days (the later sighting adds its places and its source to the existing job, and is
never re-sent), and a normalised URL (`url_norm`, https, no `www`, no tracking
parameters) that is unique across every source.

**Insert-then-send outbox.** A job row is written with `notified = 0` before the Telegram
call and flipped to `1` only after Telegram accepts it. A failed send leaves a retryable
row instead of losing the job.

**Errors are rows, not logs.** Every per-company call is wrapped and failures go to the
`errors` table. `source_runs` adds a funnel per tick and per busy company (fetched, new,
passed each filter, queued). A tick row that never closes is a tick killed by a limit,
which no handler can log from inside.

**Dead boards switch themselves off.** A board that answers 404 on five polls in a row is
set to `active = 0` and logged to `errors` with stage `auto-disable`. Only a 404 on the
board request counts: a 404 on one job's page does not, and any other failure or a good
poll resets the count.

**Cheap on writes.** A poll that finds nothing new writes no row of its own and does not
rewrite a healthy board. Every row costs index writes too, so the budget is spent on
real changes.

## Sources

Each module in [`src/sources/`](src/sources/) exports the same `Source` interface. The
`board` column means something different per source type:

| id | kind | `board` holds |
| --- | --- | --- |
| `greenhouse`, `lever`, `ashby` | ATS | the employer's board slug (`stripe`) |
| `smartrecruiters` | ATS | the company identifier (`ServiceNow`). An unknown company answers 200 with an empty list, so an empty first page counts as a 404 |
| `himalayas` | role search | `query\|scope`, scope `IN`, `WORLDWIDE` or blank (`ai engineer\|IN`). The row is a search, not an employer |
| `remotive`, `remoteok` | feed | a category slug, or `all` |
| `adzuna` | aggregator | `country:what:where`, for example `in:python developer:pune` |
| `jsearch` | aggregator | `query\|country\|date_posted` |

Company boards only cover the companies you list. The role-search rows are how it reaches
the rest: one row per query, polled in rotation like any board. Postings from a source that
reports them are dropped before filtering if they are contract, part time or temporary, or
tagged only senior.

Some boards cannot be polled from a Worker at all. Their list payload is too big to parse
inside 10ms: OpenAI (13 MB), Palantir (5.8 MB) and Harvey (4.7 MB) were measured. Those
belong in the local tools that post to `/ingest`.

### On Indeed, Glassdoor, Naukri and friends

Adzuna and JSearch exist because the big job sites cannot be polled directly. All of the
following were probed and none is usable from a Worker:

| site | result |
| --- | --- |
| Indeed | RSS `404`, search `403` (Publisher API closed 2023) |
| Glassdoor | HTML only (API deprecated 2021) |
| ZipRecruiter | `502` on the public path; partner API gated |
| Naukri | internal API returns `406 recaptcha required` |
| Monster India | internal middleware, `400` |
| Snagajob | `403` Cloudflare bot challenge |
| SimplyHired, Jora, WorkIndia, Hirect, Jobcase | no feed at all |

Even where the HTML is reachable it is 260KB to 870KB per page, which cannot be parsed
inside a 10ms CPU budget. Adzuna and JSearch license the same inventory and return compact
JSON, so they are the supported route to those listings. Two limits to know:

- **Adzuna truncates descriptions** to roughly 200 characters, so the years-of-experience
  parse usually finds nothing and an unknown number is not sent. Treat it as low yield.
- **JSearch's free tier is 200 requests per month.** Its seed row ships with `active = 0`.

## Filtering

[`src/filters.ts`](src/filters.ts) and [`src/pipeline.ts`](src/pipeline.ts) are pure: no
I/O, no bindings, so the whole gate is unit-testable. The order matters:

1. **Hard title exclude**, before anything else: `staff`, `senior`, `sr`, `principal`,
   `director`, `architect`, level markers (`II`, `III`, `L4`, `SDE 2`, `Engineer 3`) and
   `intermediate`. Softer words (`lead`, `manager`, `head of`, `VP` and
   the deny list in `FILTERS`) are also excluded, except that an explicit `L1` band waives
   those ("Technical Lead L1" is an entry role where that scheme is used) while never
   waiving the strict ones above. Whole-word matching, so `SRE` and `Leadership Program`
   survive.
2. **Role allowlist** from `FILTERS.titleAllow`. Entry-level wording alone (`intern`,
   `graduate`, `junior`) does not get a title through, because `entryBoostAllow` is off.
3. **Place**, tested one place at a time. A posting that lists several places passes if
   any one is eligible, and only the eligible ones are kept, so a message never
   advertises a place you cannot take.
4. **Freshness**, 30 days.
5. **Description gates**: deny phrases, work-authorization clauses, and for an
   internship a PPO or conversion offer.
6. **Years of experience**, ceiling 2. Within one range the low end wins (`1-3 years`
   admits a 1-year candidate); across separate mentions the highest floor wins (`5+ years
   overall, 1+ with Python` is a 5-year requirement). **A description that names no number
   is not sent** (`SEND_UNKNOWN_YOE=false`); when set to `true` it is sent only if the
   title reads entry-level. A PPO internship is exempt, since interns rarely state one.

Messages are prefixed by what the parse found: ✅ entry level, 🔸 above the entry bar but
inside the ceiling, ❓ no number named.

## The approval queue

`jobs` is both the outbox and the queue. Each row has a `status`: `new`, `approved`,
`skipped`, `applying`, `applied`, `failed` or `manual`.

- Up to 10 new jobs go out as one message each with `✅ Apply` and `❌ Skip`. More than 10
  becomes a digest, 5 jobs per message with a numbered button row per job, about one message
  a second.
- A tap hits `POST /tg-webhook`, which checks Telegram's secret header, then that the tap
  came from `TELEGRAM_CHAT_ID` (and from `TELEGRAM_OWNER_USER_ID` if set; a group needs it).
  It updates the job, answers the tap and rewrites the message without its buttons. Only a
  `new` job answers to a button, so a stale button cannot reopen a decision.
- `GET /queue?status=approved` and `POST /jobs/:id/status` are for a local applier to claim
  and finish jobs. The allowed moves are a fixed table, and `applied` is final.
- `POST /ingest` takes jobs from anything else. Items from `x` skip the filters (a tweet
  has no structured title); every other source goes through the same gates as a polled job.

Machine endpoints answer **503 when their secret is unset**, never open.

## Setup

```bash
npm install
npx wrangler d1 create job-bot-db     # then paste database_id into wrangler.jsonc
npm run migrate                       # apply migrations/ locally
cp .dev.vars.example .dev.vars        # fill in the values
npm run dev
```

Create a bot with [@BotFather](https://t.me/botfather) and add it to your chat. Secrets are
set with `wrangler secret put`, never committed:

| Secret | For |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Sending messages. If it leaks, revoke it in BotFather and set the new one |
| `TELEGRAM_CHAT_ID` | The chat or group the bot posts to (a group id is negative) |
| `TELEGRAM_OWNER_USER_ID` | Your own user id; restricts button taps in a group |
| `INGEST_KEY` | Guards `/ingest`, `/queue`, `/jobs/:id/status`, `/x/*` |
| `TG_WEBHOOK_SECRET` | Telegram echoes it on every webhook call |
| `ADMIN_TOKEN` | Optional, gates `POST /run` |
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `RAPIDAPI_KEY` | Optional, for the aggregator sources |

`SEND_UNKNOWN_YOE` is a plain var in `wrangler.jsonc`. The full walk-through, including the
exact `setWebhook` call, is in [`SETUP.md`](SETUP.md).

Deploy:

```bash
npm run migrate:remote
npm run deploy
```

### Adding boards

Boards are resolved locally, never in the Worker:

```bash
# edit data/companies.txt, one company per line; pin a wrong guess as  Name = greenhouse:slug
npm run discover-slugs     # probes Greenhouse, Lever, Ashby and SmartRecruiters, writes seed.sql
npm run seed               # applies it locally; --remote for prod
```

Pinned slugs are probed too and reported as `PIN DEAD` if the board is gone. **Add boards in
small batches.** The first poll of a new board marks every posting it lists as seen, and
each of those is a D1 write against the daily limit.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local Worker, D1 emulated |
| `npm test` | vitest, against a real Workers runtime |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | Apply `migrations/` locally |
| `npm run migrate:remote` | Apply `migrations/` to prod D1 |
| `npm run discover-slugs` | Resolve company names to verified boards |
| `npm run seed` | Seed companies locally (`--remote` for prod) |
| `npm run deploy` | `wrangler deploy` |

## HTTP endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Row counts from D1, `stale6h` (boards not polled in 6h) and `unfinishedTicks24h` |
| `POST /run` | `x-admin-token` if set | Run one tick now |
| `POST /ingest` | `X-Ingest-Key` | Queue up to 25 jobs |
| `POST /tg-webhook` | Telegram secret header, your chat | Button taps |
| `GET /queue` | `X-Ingest-Key` | Jobs in a status |
| `POST /jobs/:id/status` | `X-Ingest-Key` | Move a job along |
| `GET`, `POST /x/state` | `X-Ingest-Key` | The X scraper's cursors and run gate |
| `POST /x/alert` | `X-Ingest-Key` | One Telegram alert per outage |

## Schema

| Table | Purpose |
| --- | --- |
| `companies` | Boards and role searches: `source`, `board`, `active`, `last_polled_at`, `fail_count`, `consec_404`. No CHECK on `source`; ids are validated in code |
| `seen_postings` | Every external id ever observed; the phase-1 diff set |
| `jobs` | Outbox and approval queue: `status`, `source`, `sources`, `url_norm`, `fuzzy_key`, `locations` |
| `source_runs` | The funnel per tick and per busy company |
| `errors` | One row per caught failure |
| `meta` | Key/value, holds the X scraper's cursors and run times |

> **Migration warning.** `seen_postings` and `jobs` declare `REFERENCES companies (id) ON
> DELETE CASCADE`. Rebuilding `companies` fires that cascade on the `DROP`: migration 0004
> lost about 1200 rows to it. Copying the children out first (migrations 0005 and 0007) is
> safe, but it **costs writes**: those two migrations wrote about 115,000 rows on a database
> of 14,000 and used the whole free daily write budget, so writes failed until midnight UTC.
> Future schema changes should be `ALTER TABLE ... ADD COLUMN` only. `npx wrangler d1 info
> job-bot-db` shows `rows_written_24h`.

## Constraints

This Worker deliberately runs **without `nodejs_compat`**, so an accidental `node:*` import
fails the build rather than at runtime. That means no `fs`, `net`, `path`, or Node `crypto`
(hashing goes through `crypto.subtle`), and no `process.env`: every binding and secret
arrives on the `env` argument.

Anything needing Node or Python lives outside `src/`: [`scripts/`](scripts/) is local tooling
and [`x-scraper/`](x-scraper/) and [`linkedin-scraper/`](linkedin-scraper/) are separate Python projects.
None of them ship to the Worker.

## Not built yet

- A local applier that reads `GET /queue?status=approved`, scores each job against your CV,
  tailors the CV and fills the form. It stops before Submit, so you press it.
- More free role-search feeds (Jobicy, Arbeitnow, We Work Remotely), a Hacker News "Who is
  hiring" reader, and a local JobSpy runner for Indeed, Naukri, Google Jobs and logged-out LinkedIn.
- A weekly Telegram summary of per-source health.
