# linkedin-scraper

Reads LinkedIn job listings for the searches in `config.json` and pushes them to the job-bot Worker
(`POST /ingest`). The Worker filters them like any other source, queues what passes, and sends you a Telegram
message with `Apply` and `Skip`. It uses the [`linkedin-jobs-scraper`](https://github.com/spinlud/py-linkedin-jobs-scraper)
library. **It only reads. It never applies to anything.**

## Read this before the first live run

- **The library needs a signed-in LinkedIn session.** Version 8 has no logged-out mode. You sign in once in a
  Chrome window with `lijs login`, and the session is kept in `~/.lijs/chrome-profile`, outside this repo.
- **Scraping breaks LinkedIn's terms, and LinkedIn restricts accounts that do it.** The usual outcomes are a
  checkpoint, a temporary restriction or a permanent one. Do **not** use the account you rely on to get hired.
- **This overrides the rule in the original spec, "No LinkedIn automation".** That was a deliberate change of
  decision, made on 2026-10-28. The programme is built to stay on the safe side of it: read-only, never applying,
  and with the stops below.
- **I could not test it against live LinkedIn.** It needs Chrome and your login. The library calls in
  `ll/fetch.py` are written from the library's documented API and are the one untested layer; everything after
  them (mapping, guard rails, the Worker side) has offline tests.

A way to read LinkedIn **without** an account is JobSpy's LinkedIn mode, which is guest-only. It is not built
yet, and it is the better choice if you would rather carry no account risk.

## The guard rails

| Rail | What it does |
| --- | --- |
| Opt-in | A live run refuses to start unless `.env` has `LINKEDIN_ACCEPT_RISK=yes`. Offline runs need nothing |
| Small | At most 8 searches a run and 15 jobs per search; the shipped config is 6 searches of 10. `config.json` above the caps is refused |
| Slow | At least 1.5 seconds between jobs, a 20 to 60 second pause between searches, one Chrome, one search at a time |
| Sparse | At most one run every 6 hours, enforced from a local state file |
| Stops on the first sign of trouble | A throttle, a captcha or checkpoint, or a dead session ends the run at once and **pauses for 24 hours**. `--force` does not override a pause |
| Read only | `apply_link` is off, so no apply flow is ever opened. There is no setting for a LinkedIn password or cookie |
| Quiet logs | Session cookies (`li_at`, `li_rm`, `bcookie`, `JSESSIONID`) and the ingest key are masked before anything is written |

## What it sends

For each job it builds a normal `/ingest` item, with `source` set to `linkedin`:

- **URL:** `https://www.linkedin.com/jobs/view/<id>`, with no tracking. The Worker uses this to recognise the same
  job from any search, from X, or from a company board.
- **Years of experience:** worked out here on the full description, counting only sentences about experience, so
  "a 15 year old company" never becomes a requirement. Sent as `yoe_min`.
- **Snippet:** the Worker only keeps 2000 characters, so it starts with the sentences that matter (experience, PPO or
  conversion wording, work authorization and sponsorship) and leaves out sentences with year figures.
- **Everything else:** title, company, place, `remote`, and the posted date.

LinkedIn is **not** a trusted source, so every job goes through the same gates as a polled one: role, place,
freshness, work authorization, years of experience, and a PPO for internships. Most results will be dropped, which
is the point. A job that LinkedIn lists is an aggregator listing: career-ops treats those as unconfirmed until you
find the role on the employer's own page.

## Setup (once)

```
cd D:\Desktop\JobSearch\job-bot\linkedin-scraper
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env
```

You also need Chrome or Chromium installed. Fill in `.env` (`JOB_BOT_URL` and `INGEST_KEY` as for the X scraper), then
sign in **yourself** in the browser window that opens, ticking "Keep me logged in":

```
.venv\Scripts\lijs.exe login
```

Your password is typed into LinkedIn's page. Nothing in this project reads, stores or sends it.

When you have read the section above and accepted it, set `LINKEDIN_ACCEPT_RISK=yes` in `.env`.

## Test it, in this order

```
.\run_linkedin_scraper.bat --dry-run --fixture fixtures\sample_jobs.json   offline: no LinkedIn, no Worker
.\run_linkedin_scraper.bat --dry-run                                        reads real LinkedIn, sends nothing
.\run_linkedin_scraper.bat                                                  a real run
python -m unittest discover -t . -s tests                                   the unit tests
```

A dry run still reads LinkedIn (and counts towards its limits), so do not repeat it needlessly.

## Schedule it (every 6 hours)

```
schtasks /Create /TN "JobBot LinkedIn Scraper" /TR "\"D:\Desktop\JobSearch\job-bot\linkedin-scraper\run_linkedin_scraper.bat\"" /SC HOURLY /MO 6 /F
```

Remove it with `schtasks /Delete /TN "JobBot LinkedIn Scraper" /F`. Logs are in `.state\linkedin_scraper.log`.

## When it stops

| You see | Meaning | What to do |
| --- | --- | --- |
| `status: paused` | A throttle or a dead session paused it for 24 hours | Wait. Look at the account in a browser first. Delete `.state\state.json` only once you are sure it is fine |
| `status: invalid_session` | The Chrome profile has no usable session | Run `lijs login` again |
| `status: rate_limited` | LinkedIn throttled or challenged it | Leave it alone for the pause. Consider fewer searches |
| `Refusing to run against LinkedIn` | `LINKEDIN_ACCEPT_RISK` is not `yes` | Read the section at the top, then set it |

## Files

| File | What it is |
| --- | --- |
| `linkedin_scraper.py` | The command line entry point |
| `ll/run.py` | One run: caps, gates, fetch, map, push |
| `ll/fetch.py` | The only code that imports the LinkedIn library |
| `ll/mapping.py` | LinkedIn job to `/ingest` item, years of experience, snippet |
| `ll/redact.py` | Keeps cookies and keys out of logs |
| `.state/` | Lock file, log, last-run and pause state (git-ignored) |
