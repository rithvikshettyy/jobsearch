"""LinkedIn job reader. Finds jobs for the searches in config.json and pushes them to job-bot /ingest.

    python linkedin_scraper.py --dry-run --fixture fixtures/sample_jobs.json   offline, no LinkedIn, no Worker
    python linkedin_scraper.py --dry-run                                       real LinkedIn read, nothing is sent
    python linkedin_scraper.py                                                 the scheduled run

READ README.md BEFORE A LIVE RUN. The library needs a signed-in LinkedIn session, scraping breaks LinkedIn's
terms, and LinkedIn restricts accounts that do it. This program only reads job listings. It never applies,
and it has no setting for a LinkedIn password or cookie.
"""
from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import os
import sys
import time
from pathlib import Path

from ll.api import ApiError, JobBotClient
from ll.fetch import FixtureFetcher, LinkedinFetcher
from ll.redact import Redactor
from ll.run import ConfigError, Deps, run

HERE = Path(__file__).resolve().parent
STATE_DIR = HERE / ".state"
LOCK_STALE_SECONDS = 60 * 60

RISK_TEXT = """Refusing to run against LinkedIn: LINKEDIN_ACCEPT_RISK is not "yes" in .env.

Why this is a deliberate step:
  - the library needs a signed-in LinkedIn session (there is no logged-out mode);
  - scraping LinkedIn breaks its terms, and LinkedIn restricts accounts that do it;
  - a restricted account is expensive if it is the one you use to find work.
Use an account you can afford to lose, read README.md, then set LINKEDIN_ACCEPT_RISK=yes.
Offline runs (--fixture) never touch LinkedIn and need no setting."""


def load_env(path: Path) -> dict[str, str]:
    """KEY=VALUE lines. Real environment variables win, so CI secrets override a stray file."""
    values: dict[str, str] = {}
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key.strip()] = value
    values.update({key: val for key, val in os.environ.items() if key in values or key.startswith(("JOB_BOT", "INGEST", "LINKEDIN_"))})
    return values


def setup_logging(secrets: list[str], verbose: bool) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    handlers: list[logging.Handler] = [
        logging.StreamHandler(sys.stdout),
        logging.handlers.RotatingFileHandler(STATE_DIR / "linkedin_scraper.log", maxBytes=500_000, backupCount=2, encoding="utf-8"),
    ]
    redactor = Redactor(secrets)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    for handler in handlers:
        handler.addFilter(redactor)
        handler.setFormatter(formatter)
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, handlers=handlers, force=True)
    logging.getLogger("httpx").setLevel(logging.DEBUG if verbose else logging.WARNING)
    logging.getLogger("selenium").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


class Lock:
    """Two overlapping runs would double the load on LinkedIn. A stale lock (a crashed run) is taken over."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.held = False

    def __enter__(self) -> "Lock":
        STATE_DIR.mkdir(exist_ok=True)
        if self.path.exists() and time.time() - self.path.stat().st_mtime > LOCK_STALE_SECONDS:
            self.path.unlink(missing_ok=True)
        try:
            os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            self.held = True
        except FileExistsError:
            self.held = False
        return self

    def __exit__(self, *_: object) -> None:
        if self.held:
            self.path.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read LinkedIn jobs and push them to job-bot.")
    parser.add_argument("--config", type=Path, default=HERE / "config.json")
    parser.add_argument("--env", type=Path, default=HERE / ".env")
    parser.add_argument("--dry-run", action="store_true", help="read and map, print what would be pushed, change nothing")
    parser.add_argument("--fixture", type=Path, help="read jobs from this JSON file instead of LinkedIn (offline)")
    parser.add_argument("--force", action="store_true", help="ignore the minimum gap between runs (never a pause after throttling)")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    env = load_env(args.env)
    setup_logging([env.get("INGEST_KEY", "")], args.verbose)
    log = logging.getLogger("linkedin_scraper")

    try:
        if args.fixture:
            fetcher = FixtureFetcher(args.fixture)
            client = None
            state_path = None
        else:
            if env.get("LINKEDIN_ACCEPT_RISK", "").strip().lower() != "yes":
                print(RISK_TEXT)
                return 2
            fetcher = LinkedinFetcher()
            have_worker = bool(env.get("JOB_BOT_URL") and env.get("INGEST_KEY"))
            if not have_worker and not args.dry_run:
                raise ApiError("JOB_BOT_URL and INGEST_KEY must be set in .env")
            client = JobBotClient(env["JOB_BOT_URL"], env["INGEST_KEY"]) if have_worker else None
            state_path = STATE_DIR / "state.json"
        deps = Deps(fetcher=fetcher, client=client)

        with Lock(STATE_DIR / "run.lock") as lock:
            if not lock.held and not args.dry_run:
                log.info("another run is in progress, exiting")
                return 0
            summary = run(cfg, deps, state_path=state_path, dry_run=args.dry_run, force=args.force)
    except (ConfigError, ApiError) as exc:
        log.error("%s", exc)
        return 2

    if args.dry_run:
        items = summary.pop("items", [])
        print(json.dumps({"summary": summary, "would_push": items}, indent=2, ensure_ascii=False))
    else:
        log.info("summary: %s", json.dumps(summary))
    # A pause, a skipped interval and a throttle are expected outcomes: exit 0 so the scheduler stays quiet.
    return 1 if summary["status"] == "partial" and summary.get("queued", 0) == 0 and summary.get("kept", 0) > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
