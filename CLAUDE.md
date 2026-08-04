# job-bot

Telegram bot. Polls ATS job boards, filters, pushes new matching jobs to one Telegram chat.

## Runtime — HARD CONSTRAINTS

- Cloudflare Workers. NOT Node.
- NO Node built-ins: no `fs`, `net`, `path`, `crypto` (node), no `process.env`.
  Bindings come from the `env` arg. Hashing = `crypto.subtle`.
  `nodejs_compat` is deliberately absent from `wrangler.jsonc` so a Node import fails at build time.
- FORBIDDEN deps: better-sqlite3, imapflow, node-cron, axios, dotenv, nodemailer, puppeteer.
- DB is D1. Access via `env.DB.prepare(...).bind(...).run()/.all()/.first()`.
- Free plan budget PER INVOCATION: 10ms CPU, 50 external subrequests, 6 concurrent connections.
  → max 8 companies per tick, `p-limit`-style manual semaphore of 6 (`src/limit.ts`).
- Cron Triggers do not retry. Every per-company call wrapped in try/catch.
  Errors go to the `errors` table, never console only.

## Non-negotiable design

- Two-phase fetch. Poll LIGHT endpoints (no `?content=true`). Diff ids against D1.
  Fetch full JD ONLY for ids not already in D1. Never regex a full JD in the poll path.
- Cursor-based sharding. `meta` table holds `cursor`; each tick takes 8 companies, wraps around.
- Dedupe key = sha256(company + '|' + normalizedTitle + '|' + location).
- Seeding is done LOCALLY, never in the Worker (`npm run seed`).

## Style

- TypeScript strict. No `any`.
- Every source module exports `fetchJobs(company, env): Promise<Job[]>` — same signature, no exceptions.
- Pure functions in `filters.ts`, zero I/O, so they're unit-testable with vitest.

## Source module contract

Each file in `src/sources/` exports a `Source` (see `src/types.ts`):

- `fetchJobs(company, env): Promise<Job[]>` — phase 1. **Exactly 1 subrequest.** Light payload only;
  never touches description bodies even when the ATS returns them inline.
- `fetchDetails(company, jobs, env): Promise<JobDetail[]>` — phase 2, only for unseen ids.
- `detailCost(n): number` — subrequests `fetchDetails` will spend on `n` jobs. The orchestrator
  uses this to stay under the 50-subrequest cap. Greenhouse/Lever = `n`, everything else = `1`.

`env` carries the API keys for the keyed aggregators — `process.env` does not exist here. The ATS
modules simply omit the parameter; TypeScript accepts the narrower signature, so they stay unchanged.

## Sources

| id                    | kind       | `board` column means                          |
| --------------------- | ---------- | --------------------------------------------- |
| `greenhouse`/`lever`/`ashby` | ATS  | employer board slug                           |
| `remotive`/`remoteok` | feed       | category slug, or `all`                       |
| `adzuna`              | aggregator | `country:what:where` (e.g. `in:python developer:pune`) |
| `jsearch`             | aggregator | `query\|country\|date_posted`                  |

Adzuna and JSearch are the supported route to Indeed / ZipRecruiter / Glassdoor / Monster / Naukri
listings — those sites cannot be polled directly (RSS removed, APIs closed, Cloudflare and reCAPTCHA
walls), and their HTML is 260KB–870KB per page, far past the 10ms CPU budget. See the header comment
in `migrations/0005_aggregator_sources.sql` for the per-site probe results.

Two caveats worth knowing before trusting their output:

- **Adzuna truncates descriptions** to ~200 chars. `descriptionDeny` and the YoE parse only see a
  snippet, so the detail gates under-match on that source. Titles and locations are complete.
- **JSearch free tier is 200 requests/MONTH.** At the current `*/2` cron that is gone in under a day,
  so its seed row ships `active = 0`. Move the cron to hourly or slower before switching it on.

## Tables

| table            | purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `companies`      | board registry (`source`, `board` slug, `active`)               |
| `seen_postings`  | every external id ever observed — the phase-1 diff set          |
| `jobs`           | notified jobs keyed by `dedupe_key`                             |
| `errors`         | per-company failures, one row per catch                        |
| `meta`           | key/value; holds `cursor`                                       |

`seen_postings` and `jobs` are separate on purpose: a repost gets a new external id but the same
`dedupe_key`, so id-diffing alone would refetch it forever while key-diffing alone would refetch
every tick.

## Commands

```
npm run dev                 # local worker, D1 emulated
npm test                    # vitest, filters + dedupe are pure so they run fast
npm run seed                # LOCAL seed of companies (--remote for prod D1)
npm run migrate             # apply migrations/ locally
npm run migrate:remote      # apply migrations/ to prod D1
npx wrangler secret put TELEGRAM_BOT_TOKEN
```
