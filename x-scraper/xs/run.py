"""One scrape run: gate, fetch, filter, push, move the cursors. Every dependency is injected."""
from __future__ import annotations

import json
import logging
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from .api import ApiError
from .fetch import urls_in
from .filtering import matches, to_item
from .links import Resolver, company_from_url, expand_url, pick_job_link, strip_tracking
from .model import AuthFailure, FetchError, RawTweet

log = logging.getLogger("xs.run")

# No em dashes: this text reaches Telegram.
AUTH_ALERT = (
    "Could not log in to X with the burner account (cookies expired, or the account was locked). "
    "Refresh X_BURNER_COOKIES in x-scraper/.env. Scraping is paused until then."
)


@dataclass
class Deps:
    fetcher: Any
    client: Any | None  # JobBotClient, or None in an offline fixture run
    resolver: Resolver | None
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
    sleep: Callable[[float], Awaitable[None]] = lambda seconds: _asleep(seconds)
    rng: random.Random = field(default_factory=random.Random)


async def _asleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def build_items(tweets: list[RawTweet], cfg: dict[str, Any], resolver: Resolver | None, seen_urls: set[str], counts: dict[str, int]) -> list[dict[str, Any]]:
    """Filter tweets and turn the keepers into /ingest items, oldest first so messages arrive in order."""
    include = cfg["keywords"]["include"]
    exclude = cfg["keywords"]["exclude"]
    fetch_cfg = cfg["fetch"]
    items: list[dict[str, Any]] = []

    for tweet in sorted(tweets, key=lambda t: int(t.id)):
        if tweet.is_retweet and not fetch_cfg["include_retweets"]:
            counts["retweet"] += 1
            continue
        if tweet.is_reply and not fetch_cfg["include_replies"]:
            counts["reply"] += 1
            continue
        keep, reason = matches(tweet.text, include, exclude)
        if not keep:
            counts["keyword"] += 1
            log.debug("skip %s: %s", tweet.id, reason)
            continue

        cleaned = [c for c in (strip_tracking(expand_url(url, resolver)) for url in urls_in(tweet)) if c]
        job_url = pick_job_link(cleaned)
        if job_url is None:
            if cfg["require_link"]:
                counts["no_link"] += 1
                continue
            job_url = tweet.url
        if job_url in seen_urls:
            counts["duplicate_in_run"] += 1
            continue
        seen_urls.add(job_url)

        company = company_from_url(job_url) if job_url != tweet.url else tweet.username
        items.append(to_item(tweet, job_url, company))
    return items


async def run(cfg: dict[str, Any], deps: Deps, *, dry_run: bool = False, force: bool = False) -> dict[str, Any]:
    """Returns a summary. Raises ApiError for a Worker failure the caller should exit non-zero on."""
    summary: dict[str, Any] = {"status": "ok", "fetched": 0, "kept": 0, "queued": 0, "duplicate": 0, "filtered": 0, "invalid": 0, "dry_run": dry_run}
    counts = {"retweet": 0, "reply": 0, "keyword": 0, "no_link": 0, "duplicate_in_run": 0}
    now = deps.now()

    state: dict[str, Any] = {"last_run_at": None, "accounts": {}}
    if deps.client is not None:
        state = deps.client.get_state()

    # One run per interval, whatever starts it: Task Scheduler, a second machine, a manual rerun.
    last = _parse_iso(state.get("last_run_at"))
    interval = timedelta(minutes=cfg["min_interval_minutes"])
    if not force and not dry_run and last is not None and now - last < interval:
        summary["status"] = "skipped_interval"
        log.info("last run was %s, minimum gap is %s minutes, nothing to do", last.isoformat(), cfg["min_interval_minutes"])
        return summary

    if not dry_run and cfg["jitter"]["start_seconds"][1] > 0:
        await deps.sleep(deps.rng.uniform(*cfg["jitter"]["start_seconds"]))

    lookback = now - timedelta(hours=cfg["fetch"]["first_run_lookback_hours"])
    per_account = cfg["fetch"]["tweets_per_account"]
    pending: list[tuple[str, dict[str, Any]]] = []
    newest: dict[str, int] = {}
    seen_urls: set[str] = set()

    try:
        for position, handle in enumerate(cfg["accounts"]):
            if position > 0 and not dry_run:
                await deps.sleep(deps.rng.uniform(*cfg["jitter"]["between_accounts_seconds"]))

            since_id = state.get("accounts", {}).get(handle)
            tweets = await deps.fetcher.fetch_one(handle, since_id, per_account)
            tweets = [t for t in tweets if since_id is None or int(t.id) > int(since_id)]
            if since_id is None:
                tweets = [t for t in tweets if t.created_at >= lookback]
            summary["fetched"] += len(tweets)
            if tweets:
                # The cursor moves past everything fetched, kept or not, so a filtered tweet is not read again.
                newest[handle] = max(int(t.id) for t in tweets)

            for item in build_items(tweets, cfg, deps.resolver, seen_urls, counts):
                pending.append((handle, item))
    except AuthFailure as exc:
        return await _auth_failed(deps, summary, dry_run, str(exc))
    except FetchError as exc:
        summary["status"] = "fetch_error"
        summary["error"] = str(exc)
        log.error("could not read X: %s", exc)
        return summary

    summary["kept"] = len(pending)
    summary["skipped"] = counts

    if dry_run:
        summary["items"] = [item for _, item in pending]
        return summary

    # Push in batches. An account whose batch failed keeps its old cursor, so next run retries it.
    failed_accounts: set[str] = set()
    size = cfg["ingest"]["batch_size"]
    for start in range(0, len(pending), size):
        batch = pending[start : start + size]
        try:
            result = deps.client.ingest([item for _, item in batch])
        except ApiError as exc:
            log.error("ingest failed: %s", exc)
            failed_accounts.update(handle for handle, _ in batch)
            summary["status"] = "partial"
            continue
        for key in ("queued", "duplicate", "filtered", "invalid"):
            summary[key] += int(result.get(key, 0))

    advance = {handle: str(tweet_id) for handle, tweet_id in newest.items() if handle not in failed_accounts}
    deps.client.post_state(accounts=advance, run_at=now.isoformat(), ok=summary["status"] == "ok")
    log.info(
        "run done: fetched=%s kept=%s queued=%s duplicate=%s filtered=%s skipped=%s",
        summary["fetched"], summary["kept"], summary["queued"], summary["duplicate"], summary["filtered"], json.dumps(counts),
    )
    return summary


async def _auth_failed(deps: Deps, summary: dict[str, Any], dry_run: bool, detail: str) -> dict[str, Any]:
    """Alert once, record the attempt so the schedule does not hammer X, and finish without an error."""
    summary["status"] = "auth_failure"
    log.error("X login failed: %s", detail)
    if dry_run or deps.client is None:
        log.info("dry run: would send a Telegram alert")
        return summary
    try:
        result = deps.client.alert(AUTH_ALERT)
        summary["alert_sent"] = bool(result.get("sent"))
        deps.client.post_state(run_at=deps.now().isoformat())
    except ApiError as exc:
        log.error("could not send the alert: %s", exc)
    return summary
