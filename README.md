# job-bot

A Cloudflare Worker that polls job boards on a cron, filters the results down to
entry-level engineering roles in India (or remote roles open to India), and pushes
the survivors to a Telegram chat.

It runs entirely on Cloudflare's free plan: a Worker for the logic, D1 for state,
Cron Triggers for the schedule. No server, no queue, no scraper.

```
┌──────────┐   cron */2    ┌────────────┐   phase 1    ┌─────────────┐
│  Trigger │──────────────▶│  runTick   │─────────────▶│ 8 job board │
└──────────┘               │            │  light poll  │  endpoints  │
                           │            │◀─────────────└─────────────┘
                           │            │   ids only
                           │            │
                           │            │   phase 2    ┌─────────────┐
                           │            │─────────────▶│  full JDs   │
                           │            │  unseen ids  │  (new only) │
                           └─────┬──────┘              └─────────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌─────────┐  ┌──────────┐  ┌──────────┐
              │   D1    │  │ filters  │  │ Telegram │
              │ dedupe  │  │  (pure)  │  │  outbox  │
              └─────────┘  └──────────┘  └──────────┘
```

## Why it is built this way

The free plan gives each invocation **10ms of CPU, 50 subrequests, and 6 concurrent
connections**. Cron Triggers also never retry. Almost every design decision here
falls out of those three facts.

**Two-phase fetch.** Phase 1 polls a light endpoint per company and diffs the returned
ids against D1. Only ids that have never been seen get a phase-2 fetch for the full
job description. A naive poller re-reads every description on every tick and blows the
subrequest budget within a handful of companies; this one spends roughly one
subrequest per company on a quiet tick.

**Cursor sharding.** 51 active boards do not fit in one invocation. The `meta` table
holds a cursor, each tick takes the next 8 companies and wraps around, so the full
list rotates over several ticks. The cursor advances *before* polling starts — a tick
that dies half-way must not re-poll the same shard forever while the rest starves.

**Two dedupe layers.** `seen_postings` tracks every external id ever observed;
`jobs` is keyed by `sha256(company|title|location)`. They are separate on purpose: a
repost gets a new external id but the same content hash, so id-diffing alone would
notify it again, and hash-diffing alone would re-fetch its description every tick.

**Insert-then-send outbox.** A job row is written with `notified = 0` *before* the
Telegram call and flipped to `1` only after Telegram accepts it. A failed send leaves
a retryable row instead of losing the job.

**Errors are rows, not logs.** Every per-company call is wrapped, and failures go to
the `errors` table. On a trigger that never retries, a failure that only reached
`console` is a failure nobody can see.

## Sources

Each module in [`src/sources/`](src/sources/) exports the same `Source` interface.
The `board` column means something different per source type:

| id                           | kind       | `board` holds                                          |
| ---------------------------- | ---------- | ------------------------------------------------------ |
| `greenhouse`, `lever`, `ashby` | ATS      | the employer's board slug (`stripe`)                   |
| `remotive`, `remoteok`       | feed       | a category slug, or `all`                              |
| `adzuna`                     | aggregator | `country:what:where` — `in:python developer:pune`       |
| `jsearch`                    | aggregator | `query\|country\|date_posted`                          |

### On Indeed, Glassdoor, Naukri and friends

Adzuna and JSearch exist because the big job sites cannot be polled directly. All of
the following were probed and none is usable from a Worker:

| site                                         | result                                        |
| -------------------------------------------- | --------------------------------------------- |
| Indeed                                       | RSS `404`, search `403` (Publisher API closed 2023) |
| Glassdoor                                    | HTML only (API deprecated 2021)               |
| ZipRecruiter                                 | `502` on the public path; partner API gated   |
| Naukri                                       | internal API returns `406 recaptcha required` |
| Monster India                                | internal middleware, `400`                    |
| Snagajob                                     | `403` Cloudflare bot challenge                |
| SimplyHired, Jora, WorkIndia, Hirect, Jobcase | no feed at all                                |

Even where the HTML is reachable it is 260KB–870KB per page, which cannot be parsed
inside a 10ms CPU budget. Adzuna and JSearch license the same inventory and return
compact JSON, so they are the supported route to those listings.

Two limits are worth knowing before trusting their output:

- **Adzuna truncates descriptions** to roughly 200 characters. `descriptionDeny` and
  the years-of-experience parse therefore under-match on that source. Titles and
  locations are complete, so the phase-1 gates behave normally.
- **JSearch's free tier is 200 requests per month**, which the `*/2` cron would spend
  in well under a day. Its seed row ships with `active = 0`; move the cron to hourly
  or slower before switching it on.

## Filtering

[`src/filters.ts`](src/filters.ts) is pure — no I/O, no bindings — so the whole gate
is unit-testable. Two layers run:

**Config-driven**, from `FILTERS` in [`src/config.ts`](src/config.ts): title
allow/deny, location allowlist, max age.

**Config-free**, encoding the parts of the search that never change:

- Seniority denylist (`senior`, `principal`, `lead`, `intern`, …), with an override so
  an explicit `L1` band still passes — "Technical Lead L1" is an entry role at the
  companies that use that scheme.
- Work-authorization clauses (`us citizen`, `no visa sponsorship`, `security clearance`).
- Region-qualified remote: bare `Remote` matches, but `Portugal, Remote` and
  `US-Remote, Chicago` do not.
- Years of experience parsed from the description. Within one range the low end wins
  (`1-3 years` admits a 1-year candidate); across separate mentions the highest floor
  wins (`5+ years overall, 1+ with Python` is a 5-year req). An unstated requirement
  passes — a missed job costs more than a skimmed one.

Notifications are prefixed by what the parse found: ✅ entry-level, 🔸 above the entry
bar but inside the ceiling, ❓ the description never named a number.

## Setup

```bash
npm install
npx wrangler d1 create job-bot-db     # then paste database_id into wrangler.jsonc
npm run migrate                       # apply migrations/ locally
cp .dev.vars.example .dev.vars        # fill in your bot token
npm run dev
```

Create a bot with [@BotFather](https://t.me/botfather), add it to your chat, and put
the chat id in `TELEGRAM_CHAT_ID`. In production set it with `npx wrangler secret put
TELEGRAM_CHAT_ID` so it is never committed; locally it goes in `.dev.vars`.

Seed the company list, which is resolved locally and never in the Worker:

```bash
# edit data/companies.txt, one company per line
npm run resolve      # probes Greenhouse/Lever/Ashby, writes seed.sql
npm run seed         # applies it locally; --remote for prod
```

The resolver guesses a board slug from the company name. When it guesses wrong, pin
the answer instead: `Some Startup = greenhouse:somestartup`.

Deploy:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npm run migrate:remote
npm run deploy
```

### Optional aggregator keys

```bash
npx wrangler secret put ADZUNA_APP_ID     # free key: developer.adzuna.com
npx wrangler secret put ADZUNA_APP_KEY    # 250 calls/day
npx wrangler secret put RAPIDAPI_KEY      # JSearch, 200 calls/MONTH on the free tier
```

A source whose key is missing throws, the error lands in the `errors` table, and the
rest of the shard keeps polling — so these are genuinely optional.

Mind the quotas against your cron cadence. At `*/2` the Worker runs ~720 ticks a day;
with three Adzuna rows among 51 companies that is roughly 340 calls a day, already
over Adzuna's free limit. Either keep one Adzuna row or move the cron to `*/15`, which
loses nothing — ATS boards do not update faster than hourly.

## Commands

| Command                  | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `npm run dev`            | Local Worker, D1 emulated                  |
| `npm test`               | vitest, against a real Workers runtime      |
| `npm run typecheck`      | `tsc --noEmit`                             |
| `npm run migrate`        | Apply `migrations/` locally                |
| `npm run migrate:remote` | Apply `migrations/` to prod D1             |
| `npm run resolve`        | Resolve `data/companies.txt` → `seed.sql`  |
| `npm run seed`           | Seed companies locally (`--remote` for prod) |
| `npm run deploy`         | `wrangler deploy`                          |

## HTTP endpoints

| Route         | Purpose                                                         |
| ------------- | --------------------------------------------------------------- |
| `GET /health` | Row counts straight out of D1, doubling as a liveness check      |
| `POST /run`   | Run one tick now. Gated by `x-admin-token` when `ADMIN_TOKEN` is set |

## Schema

| Table           | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| `companies`     | Board registry — `source`, `board` selector, `active` |
| `seen_postings` | Every external id ever observed; the phase-1 diff set |
| `jobs`          | Outbox, keyed by `dedupe_key`, with a `notified` flag |
| `errors`        | One row per caught failure                            |
| `meta`          | Key/value; holds the shard `cursor`                   |

> **Migration warning.** `seen_postings` and `jobs` both declare
> `REFERENCES companies (id) ON DELETE CASCADE`. Migration `0004` rebuilt `companies`
> to widen a `CHECK` constraint and the cascade fired on the `DROP`, taking ~1200 rows
> with it. Any future rebuild must copy both child tables out to FK-free tables first
> and restore them afterwards — see `0005` for the pattern that does this correctly.

## Constraints

This Worker deliberately runs **without `nodejs_compat`**, so an accidental `node:*`
import fails the build rather than at runtime. That means no `fs`, `net`, `path`, or
Node `crypto` (hashing goes through `crypto.subtle`), and no `process.env` — every
binding and secret arrives on the `env` argument.

Anything needing Node lives in [`scripts/`](scripts/), which is local tooling and
never ships.
