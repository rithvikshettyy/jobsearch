"""One run: guard rails, fetch, map, push. Every dependency is injected."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from .api import ApiError
from .fetch import ERROR, INVALID_SESSION, OK, RATE_LIMITED
from .mapping import to_item

log = logging.getLogger("ll.run")


class ConfigError(Exception):
    """The config asks for more than the guard rails allow."""


@dataclass
class Deps:
    fetcher: Any
    client: Any | None  # JobBotClient, or None for an offline fixture run
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)


def validate(cfg: dict[str, Any]) -> None:
    """Hard caps. A typo in config.json must not turn a gentle reader into a hammer."""
    limits = cfg["limits"]
    if not cfg["searches"]:
        raise ConfigError("searches is empty")
    if len(cfg["searches"]) > limits["max_searches"]:
        raise ConfigError(f"{len(cfg['searches'])} searches, but max_searches is {limits['max_searches']}")
    if limits["jobs_per_search"] > limits["max_jobs_per_search_cap"]:
        raise ConfigError(f"jobs_per_search {limits['jobs_per_search']} is over the cap of {limits['max_jobs_per_search_cap']}")
    if cfg["pacing"]["slow_mo_seconds"] < 1.0:
        raise ConfigError("slow_mo_seconds below 1.0 is refused: it is what keeps LinkedIn from throttling the account")
    if cfg["min_interval_hours"] < 1:
        raise ConfigError("min_interval_hours below 1 is refused")


def _read_state(path: Path | None) -> dict[str, Any]:
    if path is None or not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_state(path: Path | None, state: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def run(cfg: dict[str, Any], deps: Deps, *, state_path: Path | None, dry_run: bool = False, force: bool = False) -> dict[str, Any]:
    validate(cfg)
    now = deps.now()
    summary: dict[str, Any] = {"status": "ok", "fetched": 0, "kept": 0, "queued": 0, "duplicate": 0, "filtered": 0, "invalid": 0, "dry_run": dry_run}
    state = _read_state(state_path)

    # A pause after throttling or a dead session is never overridden, not even by --force: every further
    # attempt while LinkedIn is unhappy is what gets an account restricted.
    paused_until = _parse(state.get("paused_until"))
    if paused_until is not None and now < paused_until:
        summary["status"] = "paused"
        summary["paused_until"] = paused_until.isoformat()
        log.warning("paused until %s (%s). Delete .state/state.json only if you have fixed the cause.", paused_until.isoformat(), state.get("paused_reason", "throttled"))
        return summary

    last = _parse(state.get("last_run_at"))
    gap = timedelta(hours=cfg["min_interval_hours"])
    if not force and not dry_run and last is not None and now - last < gap:
        summary["status"] = "skipped_interval"
        log.info("last run was %s, the minimum gap is %s hours", last.isoformat(), cfg["min_interval_hours"])
        return summary

    fetched = deps.fetcher.fetch(cfg["searches"], cfg)
    summary["fetched"] = len(fetched.jobs)

    if fetched.status in (RATE_LIMITED, INVALID_SESSION):
        summary["status"] = fetched.status
        summary["detail"] = fetched.detail
        if not dry_run:
            state["paused_until"] = (now + timedelta(hours=cfg["pause_hours_after_throttle"])).isoformat()
            state["paused_reason"] = fetched.status
            _write_state(state_path, state)
        log.error("LinkedIn said %s. Pausing for %s hours.", fetched.status, cfg["pause_hours_after_throttle"])
        return summary

    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for job in fetched.jobs:
        item = to_item(job)
        if item is None or item["url"] in seen:
            continue
        seen.add(item["url"])
        items.append(item)
    summary["kept"] = len(items)
    if fetched.status == ERROR:
        summary["status"] = "partial"
        summary["detail"] = fetched.detail

    if dry_run:
        summary["items"] = items
        return summary

    failed = False
    size = cfg["ingest"]["batch_size"]
    for start in range(0, len(items), size):
        try:
            result = deps.client.ingest(items[start : start + size])
        except ApiError as exc:
            log.error("ingest failed: %s", exc)
            failed = True
            summary["status"] = "partial"
            continue
        for key in ("queued", "duplicate", "filtered", "invalid"):
            summary[key] += int(result.get(key, 0))

    if not failed:  # a failed push is retried next run, and the Worker ignores duplicates
        state["last_run_at"] = now.isoformat()
        state.pop("paused_until", None)
        _write_state(state_path, state)
    log.info("run done: %s", json.dumps({k: v for k, v in summary.items() if k != "items"}))
    return summary


__all__ = ["ConfigError", "Deps", "OK", "run", "validate"]
