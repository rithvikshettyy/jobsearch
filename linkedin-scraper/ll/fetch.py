"""Reading LinkedIn. The ONLY module that imports linkedin_jobs_scraper.

Written against the library's documented API (version 8) and NOT run against live LinkedIn from the build
environment: it needs Chrome and a signed-in session, and signing in is the user's step. If a release renames
something, the fix is local to `_build_query` and `_job_to_dict`; everything after them is tested offline.

Safety behaviour, all deliberate:
- searches run ONE AT A TIME with a pause between them, so the first sign of throttling stops the run;
- there is no way to pass a password or a cookie through this program, the session is the library's own Chrome
  profile created by `lijs login`;
- it never opens an apply link (apply_link is off) and never applies to anything.
"""
from __future__ import annotations

import json
import logging
import random
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("ll.fetch")

OK, INVALID_SESSION, RATE_LIMITED, ERROR = "ok", "invalid_session", "rate_limited", "error"

_THROTTLE_HINTS = ("429", "too many requests", "rate limit", "throttl", "captcha", "challenge", "checkpoint", "authwall", "unusual activity")
_SESSION_HINTS = ("invalid session", "invalidcookie", "not signed in", "sign in", "session expired", "no usable session")


@dataclass
class FetchResult:
    jobs: list[dict[str, Any]] = field(default_factory=list)
    status: str = OK
    detail: str = ""


def classify(message: str) -> str:
    """Throttling and session problems stop the run; anything else is just an error to report."""
    text = message.lower()
    if any(hint in text for hint in _THROTTLE_HINTS):
        return RATE_LIMITED
    if any(hint in text for hint in _SESSION_HINTS):
        return INVALID_SESSION
    return ERROR


def _job_to_dict(data: Any) -> dict[str, Any]:
    """An EventData as a plain dict with only the fields the mapping reads."""
    return {name: getattr(data, name, None) for name in ("job_id", "link", "title", "company", "place", "description", "date", "date_text", "insights")}


class LinkedinFetcher:
    name = "linkedin-jobs-scraper"

    def __init__(self, sleep: Callable[[float], None] = time.sleep, rng: random.Random | None = None) -> None:
        self._sleep = sleep
        self._rng = rng or random.Random()

    @staticmethod
    def _build_query(search: dict[str, Any], cfg: dict[str, Any]) -> Any:
        from linkedin_jobs_scraper.filters import ExperienceLevelFilters, OnSiteOrRemoteFilters, RelevanceFilters, TimeFilters, TypeFilters
        from linkedin_jobs_scraper.query import Query, QueryFilters, QueryOptions

        wanted = cfg["filters"]
        filters: dict[str, Any] = {
            "relevance": RelevanceFilters.RECENT,
            "time": TimeFilters[wanted["time"].upper()],
            "type": [TypeFilters[name.upper()] for name in wanted["types"]],
            "experience": [ExperienceLevelFilters[name.upper()] for name in wanted["experience"]],
        }
        if search.get("remote_only"):
            filters["on_site_or_remote"] = [OnSiteOrRemoteFilters.REMOTE]
        return Query(
            query=search["query"],
            options=QueryOptions(
                locations=list(search["locations"]),
                apply_link=False,  # never open an apply flow
                skip_promoted_jobs=True,
                limit=cfg["limits"]["jobs_per_search"],
                filters=QueryFilters(**filters),
            ),
        )

    def fetch(self, searches: list[dict[str, Any]], cfg: dict[str, Any]) -> FetchResult:
        from linkedin_jobs_scraper import LinkedinScraper
        from linkedin_jobs_scraper.events import Events

        result = FetchResult()
        problems: list[str] = []

        def on_data(data: Any) -> None:
            result.jobs.append(_job_to_dict(data))

        def on_error(error: Any) -> None:
            problems.append(str(error))

        scraper = LinkedinScraper(
            headless=True,
            max_workers=1,  # one Chrome, one search at a time
            slow_mo=cfg["pacing"]["slow_mo_seconds"],
            page_load_timeout=cfg["pacing"]["page_load_timeout_seconds"],
        )
        scraper.on(Events.DATA, on_data)
        scraper.on(Events.ERROR, on_error)
        invalid = getattr(Events, "INVALID_SESSION", None)
        if invalid is not None:
            scraper.on(invalid, lambda *_: problems.append("invalid session"))

        for position, search in enumerate(searches):
            if position > 0:
                self._sleep(self._rng.uniform(20, 60))
            problems.clear()
            try:
                scraper.run([self._build_query(search, cfg)])
            except Exception as exc:  # noqa: BLE001 - the library raises InvalidCookieException and others
                problems.append(f"{type(exc).__name__}: {exc}")

            if problems:
                status = max((classify(message) for message in problems), key=[OK, ERROR, INVALID_SESSION, RATE_LIMITED].index)
                if status in (INVALID_SESSION, RATE_LIMITED):
                    result.status = status
                    result.detail = problems[0][:200]
                    log.error("stopping after search %d of %d: %s", position + 1, len(searches), status)
                    break
                log.warning("search %r reported: %s", search["query"], problems[0][:200])
                result.status = ERROR
                result.detail = problems[0][:200]
        return result


class FixtureFetcher:
    """Reads jobs from a JSON file shaped like the library's events. Offline, no Chrome, no LinkedIn."""

    name = "fixture"

    def __init__(self, path: Path) -> None:
        data = json.loads(path.read_text(encoding="utf-8"))
        self._jobs = data["jobs"] if isinstance(data, dict) else data

    def fetch(self, searches: list[dict[str, Any]], cfg: dict[str, Any]) -> FetchResult:
        return FetchResult(jobs=list(self._jobs))
