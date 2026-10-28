# Setup

Parts are added here as they are built. Never paste a real secret into this file, a commit or a chat.

## Part 2: Telegram approval queue

Every new job is sent with `✅ Apply` and `❌ Skip` buttons. A tap writes the decision to D1. Nothing is ever
applied to without a `✅ Apply` tap.

Replace `YOUR-SUBDOMAIN` in the commands below with the one `wrangler deploy` prints (the `*.workers.dev` URL).

### 1. Secrets

Both are random strings. PowerShell generates one:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
```

```
npx wrangler secret put INGEST_KEY          # guards /ingest, /queue, /jobs/:id/status
npx wrangler secret put TG_WEBHOOK_SECRET   # Telegram echoes it back on every webhook call
npx wrangler secret put TELEGRAM_CHAT_ID    # the chat or group the bot posts to (a group id is negative)
```

`TG_WEBHOOK_SECRET` may only contain `A-Z a-z 0-9 _ -` (Telegram's rule). Keep a copy of both in a password
manager: the scraper and the applier need `INGEST_KEY` in their own `.env`.

Optional, only if `TELEGRAM_CHAT_ID` is a group: `npx wrangler secret put TELEGRAM_OWNER_USER_ID` with your
numeric Telegram user id, so only you can tap the buttons. In a private chat the chat id already is you.

A missing `INGEST_KEY` or `TG_WEBHOOK_SECRET` closes its endpoints with a 503. It never leaves them open.

### 2. Migrate and deploy

```
npm run migrate:remote
npx wrangler deploy
```

Migration 0008 marks every job already in D1 as `skipped` (it was sent before there was a queue) and adds the
queue columns. It does not rebuild `jobs`.

### 3. Point Telegram at the Worker

Replace the two placeholders. The Worker URL is the one `wrangler deploy` prints.

```
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://job-bot.YOUR-SUBDOMAIN.workers.dev/tg-webhook","secret_token":"<TG_WEBHOOK_SECRET>","allowed_updates":["callback_query"],"drop_pending_updates":true}'
```

PowerShell:

```powershell
$body = @{ url = "https://job-bot.YOUR-SUBDOMAIN.workers.dev/tg-webhook"; secret_token = "<TG_WEBHOOK_SECRET>"; allowed_updates = @("callback_query"); drop_pending_updates = $true } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" -ContentType "application/json" -Body $body
```

Check it took (the response must show your URL and `pending_update_count`, with no `last_error_message`):

```
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

### 4. Try it

```
curl -X POST https://job-bot.YOUR-SUBDOMAIN.workers.dev/ingest \
  -H "x-ingest-key: <INGEST_KEY>" -H "content-type: application/json" \
  -d '{"url":"https://example.com/jobs/1","title":"AI Engineer","company":"Acme","location":"Bengaluru, India","source":"manual","description_snippet":"0-1 years of experience"}'
```

You should get `{"queued":1,...}` and a Telegram message with the two buttons. Tap `✅ Apply`, then:

```
curl -H "x-ingest-key: <INGEST_KEY>" "https://job-bot.YOUR-SUBDOMAIN.workers.dev/queue?status=approved"
```

### Endpoints

| Method and path | Auth | What it does |
| --- | --- | --- |
| `POST /ingest` | `X-Ingest-Key` | Queue up to 25 jobs. One object, an array, or `{"jobs": [...]}` |
| `POST /tg-webhook` | `X-Telegram-Bot-Api-Secret-Token`, and only your chat | Handles the button taps |
| `GET /queue?status=approved&limit=20` | `X-Ingest-Key` | Jobs in a status, oldest decision first |
| `POST /jobs/:id/status` | `X-Ingest-Key` | `{"status": "applying"}`, plus `fail_reason` for `failed` or `manual` |

`/ingest` item fields: `url`, `title`, `company`, `source` (required), then `location`, `remote`, `yoe_min`,
`posted_at`, `description_snippet`, `tweet_url`. Items from `x` skip the role, place and JD gates; every other
source goes through the same ones a polled job does. The same posting seen twice, from any sources, is one job
with all its sources listed.

Statuses: `new`, `approved`, `skipped`, `applying`, `applied`, `failed`, `manual`.

## Part 1: X scraper

Lives in the `x-scraper` folder of this repo (`D:\Desktop\JobSearch\job-bot\x-scraper` on this machine). Full steps are in its `README.md`; the short version:

1. Finish Part 2 first (the scraper pushes to `/ingest`, and needs `INGEST_KEY`).
2. Create a **burner** X account, copy its `auth_token` and `ct0` cookies into `x-scraper\.env` (see `.env.example`).
3. `py -3 -m venv .venv`, then `.venv\Scripts\python.exe -m pip install -r requirements.txt`.
4. Test: `run_x_scraper.bat --dry-run --fixture fixtures\sample_tweets.json`, then `--dry-run` against real X.
5. Schedule it, every 30 minutes:

```
schtasks /Create /TN "JobBot X Scraper" /TR "\"D:\Desktop\JobSearch\job-bot\x-scraper\run_x_scraper.bat\"" /SC MINUTE /MO 30 /F
```

State lives in D1 (`meta` table), so the scraper can move machines. The Worker holds three more endpoints for it,
all behind `X-Ingest-Key`: `GET /x/state` (last tweet id per account, last run time), `POST /x/state` (moves a
cursor forward only), `POST /x/alert` (one Telegram alert per 12 hours, for a login failure).

## Part 4: ATS coverage

Polled boards: Greenhouse, Lever, Ashby, and now SmartRecruiters (`source = 'smartrecruiters'`, `board` = the company
identifier, for example `ServiceNow`).

**Finding boards.** `npm run discover-slugs` (the existing `scripts/resolve.mjs`) turns company names into verified
boards. Put one name per line in `data/companies.txt`, or pass `--in`/`--out`:

```
npm run discover-slugs -- --in data/companies.proposed.txt --out seed.proposed.sql
```

It probes all four ATSs for each name. A pinned line (`Sarvam AI = ashby:sarvam`) is now probed too, and reported as
`PIN DEAD` if the board is gone, instead of going into the seed unchecked. `--no-verify-pins` skips that. Review the
SQL it writes before applying it.

**Dead boards switch themselves off.** After 5 polls in a row that return 404 for the board, the company is set to
`active = 0` and a row is written to `errors` (`stage = 'auto-disable'`, message `switched off after 5 consecutive
404s from greenhouse:phonepe`). One 404 on a single job's page does not count, and any other failure or a good poll
resets the count. List what was switched off:

```
npx wrangler d1 execute job-bot-db --remote --command "SELECT ts, company, message FROM errors WHERE stage = 'auto-disable' ORDER BY ts DESC"
```

SmartRecruiters answers 200 with an empty list for a company that does not exist, so for that ATS an empty first page
counts as a 404. A real company with nothing open for 5 polls in a row is switched off too; set it back with
`UPDATE companies SET active = 1, consec_404 = 0 WHERE name = '...'`.

`companies.last_polled_at` and `fail_count` were added in migration 0006; `consec_404` is the counter above.
