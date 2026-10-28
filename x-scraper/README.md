# x-scraper

Reads tweets from the accounts in `config.json`, keeps the job posts, and pushes them to the job-bot Worker
(`POST /ingest`). The Worker queues them and sends you a Telegram message with `✅ Apply` and `❌ Skip`.
Nothing here applies to anything.

Accounts: `@RohoolAgi`, `@Ajay_2512x` (edit `config.json` to change them).

## What it does each run

1. Asks the Worker for the last tweet id handled per account and the time of the last run. If the last run was
   under 30 minutes ago it exits (the gap is `min_interval_minutes`; `--force` skips it).
2. Waits a random 0 to 90 seconds, and 8 to 30 seconds between accounts, so it does not run on the clock.
3. Reads new tweets with **twscrape**; if that fails it tries **twikit**. First run only looks back 48 hours.
4. Drops retweets and replies, then keeps a tweet only if it has one include keyword and no exclude keyword
   (`config.json`, whole words, case-insensitive) and carries a job link.
5. Expands `t.co` and other known shorteners, strips tracking parameters, and names the company from the link.
6. Pushes in batches of 25, then moves each account's cursor. An account whose batch failed keeps its old cursor,
   and the Worker ignores duplicates, so a retry is safe.

If the burner cannot log in it sends **one** Telegram alert (the Worker sends it, so this folder holds no bot
token; at most one every 12 hours) and exits with code 0 so the scheduler stays quiet.

## Setup (once)

```
cd D:\Desktop\JobSearch\job-bot\x-scraper
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env
```

Then fill in `.env`:

- `JOB_BOT_URL` and `INGEST_KEY`: the Worker URL and the value you set with `wrangler secret put INGEST_KEY`.
- `X_BURNER_USERNAME` and `X_BURNER_COOKIES`: a **burner** X account, never your own. Log in to it in a browser,
  open DevTools, Application, Cookies, `https://x.com`, and copy `auth_token` and `ct0` into one line:
  `auth_token=...; ct0=...`.

Scraping X with an account breaks X's terms. The account can be locked or banned, which is why it must be a
burner. The cookies expire every few weeks; the Telegram alert tells you when to refresh them.

## Test it, in this order

```
run_x_scraper.bat --dry-run --fixture fixtures\sample_tweets.json   offline: no X, no Worker, nothing sent
run_x_scraper.bat --dry-run                                         reads real X, prints what it would push, sends nothing
run_x_scraper.bat --force                                           first real run
python -m unittest discover -t . -s tests                           the unit tests
.venv\Scripts\python.exe explain.py                                 every recent tweet with the filter's verdict, to tune config.json
```

`explain.py` logs in like a dry run does, sends nothing and saves nothing. Use it when the filter keeps too little or
too much: each line shows whether the tweet was kept or skipped, why, and how many job links it has. A first live run
against these two accounts read 85 tweets and showed what the keyword lists needed (plural role words, "recruiter"
wrongly excluding an FDE internship, a course launch matching "LLMs").

## Schedule it (Windows Task Scheduler, every 30 minutes)

```
schtasks /Create /TN "JobBot X Scraper" /TR "\"D:\Desktop\JobSearch\job-bot\x-scraper\run_x_scraper.bat\"" /SC MINUTE /MO 30 /F
```

Check it, run it now, remove it:

```
schtasks /Query /TN "JobBot X Scraper" /V /FO LIST
schtasks /Run /TN "JobBot X Scraper"
schtasks /Delete /TN "JobBot X Scraper" /F
```

It runs while you are logged in. Logs are in `.state\x_scraper.log` (cookies, tokens and the ingest key are masked
before anything is written).

## GitHub Actions (optional, off by default)

The default is local. If you would rather not leave a PC on, copy `github-actions\x-scraper.yml.example` to
`.github/workflows/x-scraper.yml` and add the four secrets named in it.

**Do not do that in a public repo.** This folder lives in the job-bot repo, which is public, and the logs of a
public repo's Actions runs are readable by anyone. Use a **private** copy or fork of the repo. X also blocks many
datacenter addresses, so a GitHub runner is more likely to hit the login alert than your home connection.

## Files

| File | What it is |
| --- | --- |
| `x_scraper.py` | The command line entry point |
| `xs/run.py` | One run: gate, fetch, filter, push, move cursors |
| `xs/fetch.py` | The only code that touches twscrape and twikit |
| `xs/links.py`, `xs/filtering.py` | Link expansion and cleaning, keyword filter, `/ingest` item shape |
| `xs/redact.py` | Keeps secrets out of logs |
| `.state/` | Lock file, log, twscrape's account database (it holds the cookies, git-ignored) |
