"""Print every recent tweet from the configured accounts with the filter's verdict. Read-only: it
logs in to X like a dry run does, sends nothing to the Worker, saves nothing.

    .venv\\Scripts\\python.exe explain.py
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

from x_scraper import STATE_DIR, load_env, secrets_of, setup_logging
from xs.fetch import Fetchers, TwikitFetcher, TwscrapeFetcher, load_burners
from xs.filtering import matches
from xs.fetch import urls_in
from xs.links import is_job_candidate, strip_tracking

HERE = Path(__file__).resolve().parent


async def main() -> None:
    cfg = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
    env = load_env(HERE / ".env")
    setup_logging(secrets_of(env), verbose=False)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    burners = load_burners(env)
    fetcher = Fetchers([TwscrapeFetcher(burners, STATE_DIR / "accounts.db"), TwikitFetcher(burners)])

    for handle in cfg["accounts"]:
        tweets = await fetcher.fetch_one(handle, None, cfg["fetch"]["tweets_per_account"])
        print(f"\n===== @{handle}: {len(tweets)} tweets")
        for tweet in sorted(tweets, key=lambda t: int(t.id), reverse=True):
            keep, reason = matches(tweet.text, cfg["keywords"]["include"], cfg["keywords"]["exclude"])
            links = [strip_tracking(u) or u for u in urls_in(tweet)]
            job_links = [u for u in links if is_job_candidate(u)]
            flags = ("RT " if tweet.is_retweet else "") + ("REPLY " if tweet.is_reply else "")
            text = " ".join(tweet.text.split())[:110]
            print(f"{tweet.created_at:%m-%d} {flags}{'KEEP' if keep else 'skip'} [{reason}] links={len(job_links)} | {text}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
