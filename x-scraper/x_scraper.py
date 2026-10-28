"""X job scraper. Reads tweets from a few accounts, keeps the job posts, pushes them to job-bot /ingest.

    python x_scraper.py --dry-run --fixture fixtures/sample_tweets.json    offline, no X, no Worker
    python x_scraper.py --dry-run                                          real X read, nothing is sent or saved
    python x_scraper.py                                                    the scheduled run

Secrets come from .env only. Nothing here prints a cookie, a token or the ingest key.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import logging.handlers
import os
import sys
import time
from pathlib import Path

from xs.api import ApiError, JobBotClient
from xs.fetch import FixtureFetcher, Fetchers, TwikitFetcher, TwscrapeFetcher, load_burners
from xs.links import make_http_resolver
from xs.model import ConfigError
from xs.redact import Redactor
from xs.run import Deps, run

HERE = Path(__file__).resolve().parent
STATE_DIR = HERE / ".state"
LOCK_STALE_SECONDS = 20 * 60


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
    values.update({key: val for key, val in os.environ.items() if key in values or key.startswith(("X_BURNER", "JOB_BOT", "INGEST"))})
    return values


def secrets_of(env: dict[str, str]) -> list[str]:
    """Every value that must never reach a log: the key, whole cookie strings, and each cookie value."""
    found = [env.get("INGEST_KEY", "")]
    for name, value in env.items():
        if name.endswith("_COOKIES"):
            found.append(value)
            found.extend(part.split("=", 1)[1].strip() for part in value.split(";") if "=" in part)
    return [secret for secret in found if secret]


def setup_logging(secrets: list[str], verbose: bool) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout), logging.handlers.RotatingFileHandler(STATE_DIR / "x_scraper.log", maxBytes=500_000, backupCount=2, encoding="utf-8")]
    redactor = Redactor(secrets)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    for handler in handlers:
        handler.addFilter(redactor)
        handler.setFormatter(formatter)
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, handlers=handlers, force=True)


class Lock:
    """A run that overlaps another would double-post. A stale lock (crashed run) is taken over."""

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
    parser = argparse.ArgumentParser(description="Scrape job tweets and push them to job-bot.")
    parser.add_argument("--config", type=Path, default=HERE / "config.json")
    parser.add_argument("--env", type=Path, default=HERE / ".env")
    parser.add_argument("--dry-run", action="store_true", help="read and filter, print what would be pushed, change nothing")
    parser.add_argument("--fixture", type=Path, help="read tweets from this JSON file instead of X (offline)")
    parser.add_argument("--force", action="store_true", help="ignore the 30 minute gap between runs")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    env = load_env(args.env)
    setup_logging(secrets_of(env), args.verbose)
    log = logging.getLogger("x_scraper")

    try:
        if args.fixture:
            fetcher = FixtureFetcher(args.fixture)
            client = None
            resolver = fetcher.resolver
        else:
            burners = load_burners(env)
            fetcher = Fetchers([TwscrapeFetcher(burners, STATE_DIR / "accounts.db"), TwikitFetcher(burners)])
            have_worker = bool(env.get("JOB_BOT_URL") and env.get("INGEST_KEY"))
            if not have_worker and not args.dry_run:
                raise ConfigError("JOB_BOT_URL and INGEST_KEY must be set in .env")
            client = JobBotClient(env["JOB_BOT_URL"], env["INGEST_KEY"]) if have_worker else None
            resolver = make_http_resolver(cfg["link_expansion"]["timeout_seconds"], cfg["link_expansion"]["max_hops"])
    except (ConfigError, ApiError) as exc:
        log.error("setup problem: %s", exc)
        return 2

    deps = Deps(fetcher=fetcher, client=client, resolver=resolver)

    with Lock(STATE_DIR / "run.lock") as lock:
        if not lock.held and not args.dry_run:
            log.info("another run is in progress, exiting")
            return 0
        try:
            summary = asyncio.run(run(cfg, deps, dry_run=args.dry_run, force=args.force))
        except ApiError as exc:
            log.error("job-bot said no: %s", exc)
            return 1

    if args.dry_run:
        items = summary.pop("items", [])
        print(json.dumps({"summary": summary, "would_push": items}, indent=2, ensure_ascii=False))
    else:
        log.info("summary: %s", json.dumps(summary))
    # Auth failure and a skipped interval are normal outcomes, not errors: exit 0 so the scheduler stays quiet.
    return 1 if summary["status"] == "fetch_error" else 0


if __name__ == "__main__":
    sys.exit(main())
