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
  → 3 companies per tick (CPU is the binding limit, not subrequests), `p-limit`-style manual semaphore of 6 (`src/limit.ts`).
- Cron Triggers do not retry. Every per-company call wrapped in try/catch.
  Errors go to the `errors` table, never console only.

## Non-negotiable design

- Two-phase fetch. Poll LIGHT endpoints (no `?content=true`). Diff ids against D1.
  Fetch full JD ONLY for ids not already in D1. Never regex a full JD in the poll path.
- Least-recently-polled sharding. Each tick takes the 3 active companies (CPU-bound, see `config.ts`) with the oldest `companies.last_polled_at`
  (NULL first) and stamps them BEFORE polling. Every board is reached once before any is reached twice.
- Dedupe key = sha256(company + '|' + normalizedTitle + '|' + location) is the row key. On top of it,
  `fuzzy_key` = sha256(lower(company) + '|' + normalizedTitle) merges the same role across locations and boards
  inside `DEDUPE_WINDOW_DAYS` (14): the later sighting's locations are merged into the existing row, never re-sent.
- Filter order is title hard-exclude (staff/senior/lead/II/L4...), title allow, per-place location check,
  freshness, then JD gates. Unknown YOE is not sent unless `SEND_UNKNOWN_YOE` and an entry-level title.
  Locations are split on `;` and a posting passes on ANY one India/remote-open place; only those are kept.
- Search preferences live in `FILTERS` (`config.ts`): roles are FDE / AI / ML / LLM engineer only
  (`entryBoostAllow: false`), any country (`allowInternational`; US-only and work-auth clauses still reject),
  full time or an internship whose JD mentions a PPO or full-time conversion (`internRequiresPpo`).
- Nothing applies without an Apply tap: `new` only moves on a button tap (webhook, locked to `TELEGRAM_CHAT_ID`)
  or through the authenticated API. Telegram text has no em or en dashes. Machine endpoints answer 503 when their
  secret is unset, never open. Details: `SETUP.md`.
- LinkedIn: the original spec said "No LinkedIn automation". On 2026-10-28 the user chose to override that for
  READING only, via `linkedin-scraper/` (needs a signed-in session, breaks LinkedIn's terms). Keep it read-only: never
  apply, never accept a password or cookie in this repo, keep the opt-in (`LINKEDIN_ACCEPT_RISK`), the volume caps and
  the 24 hour pause on any throttle. Do not widen any of those without the user asking.
- A board that 404s `AUTO_DISABLE_404S` (5) polls in a row is switched off (`active = 0`) and logged to `errors`
  with stage `auto-disable`. Only a 404 on the board request counts: a 404 on one job's detail does not, and any
  other failure or a good poll resets the run (`companies.consec_404`).
- `source_runs` records one row per tick and one per company per tick. A tick row with `finished_at IS NULL`
  is a tick killed by a limit (shown as `unfinishedTicks24h` on /health).
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
| `smartrecruiters`    | ATS        | company identifier (case-insensitive). List is newest 100, no description; detail is 1 request per job. An unknown company answers 200 with an empty list, so an empty first page is reported as a 404. Drops contract/part-time/temporary |
| `himalayas`           | role search | `query\|scope`, scope = `IN` / `WORLDWIDE` / blank (e.g. `ai engineer\|IN`). The `companies` row is a query, not an employer. Drops contract/part-time and senior-only postings in the source |
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
| `companies`      | board or role-query registry (`source`, `board`, `active`). No CHECK on `source` since 0007: ids are validated in code, a new source needs no migration |
| `seen_postings`  | every external id ever observed — the phase-1 diff set          |
| `jobs`           | outbox AND approval queue, keyed by `dedupe_key`; the id in buttons is `rowid`. `status` new/approved/skipped/applying/applied/failed/manual, `url_norm` is the unique cross-source URL key, `sources` lists every source that found it. `/ingest` rows hang off the inactive `Ingest` company |
| `errors`         | per-company failures, one row per catch                        |
| `meta`           | key/value (the old `cursor` is unused since 0006)               |
| `source_runs`    | per-tick and per-company funnel counters, errors, subrequests   |

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
