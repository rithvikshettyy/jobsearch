"""LinkedIn job to /ingest item. Pure: no network, no library imports.

The Worker only sees a 2000 character snippet, but a LinkedIn description is long and the lines that decide
whether a job is for you (years of experience, a PPO, "must be authorized to work in the US") sit anywhere in
it. So the snippet starts with those sentences, and the minimum years are worked out here on the full text.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

SNIPPET_MAX = 1900  # the Worker truncates at 2000
KEY_MAX = 1200

_JOB_ID = re.compile(r"/jobs/view/(?:[^/?#]*-)?(\d{6,})")

# Sentences worth keeping: experience asks, PPO and conversion wording, and the work-authorization clauses the
# Worker rejects on.
_KEY_WORDS = re.compile(
    r"\b(experience|experienced|ppo|pre[\s-]?placement|convert(?:ed|ible|s)?\s+(?:in)?to|"
    r"return offer|fresher|entry[\s-]?level|authori[sz]ed to work|work authori[sz]ation|right to work|"
    r"sponsorship|visa|citizen|security clearance|permanent resident)\b",
    re.IGNORECASE,
)
_EXPERIENCE_SENTENCE = re.compile(r"\b(experience|experienced|exp|background|worked)\b", re.IGNORECASE)

_RANGE = re.compile(r"(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*(year|yr|month|mo)s?\b", re.IGNORECASE)
_SINGLE = re.compile(r"(\d{1,2})\s*\+?\s*(year|yr|month|mo)s?\b", re.IGNORECASE)


def job_id_of(job: dict[str, Any]) -> str | None:
    """The numeric LinkedIn job id, from the event's `job_id` or from the link."""
    raw = str(job.get("job_id") or "").strip()
    if raw.isdigit():
        return raw
    match = _JOB_ID.search(str(job.get("link") or ""))
    return match.group(1) if match else None


def canonical_url(job_id: str) -> str:
    """One URL per job, whatever tracking the page carried: the Worker dedupes on it."""
    return f"https://www.linkedin.com/jobs/view/{job_id}"


def _sentences(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+|\n+|•", text) if part.strip()]


def key_sentences(text: str, limit: int = KEY_MAX) -> str:
    """The sentences that mention experience, PPO or work authorization, in order, up to `limit` characters."""
    kept: list[str] = []
    used = 0
    for sentence in _sentences(text):
        if not _KEY_WORDS.search(sentence):
            continue
        trimmed = sentence[:300]
        if used + len(trimmed) + 1 > limit:
            break
        kept.append(trimmed)
        used += len(trimmed) + 1
    return " ".join(kept)


def _years(value: int, unit: str) -> int:
    return value // 12 if unit.lower().startswith("mo") else value


def parse_min_yoe(text: str) -> int | None:
    """Minimum years of experience asked for, or None when the text names no number.

    Only sentences that talk about experience count, so "founded 15 years ago" does not turn a graduate role
    into a 15 year requirement. Within a range the low end wins ("1-3 years" admits a 1 year candidate);
    across separate mentions the highest floor wins.
    """
    floors: list[int] = []
    for sentence in _sentences(text):
        if not _EXPERIENCE_SENTENCE.search(sentence):
            continue
        spans: list[tuple[int, int]] = []
        for match in _RANGE.finditer(sentence):
            floors.append(_years(int(match.group(1)), match.group(3)))
            spans.append(match.span())
        for match in _SINGLE.finditer(sentence):
            if any(start <= match.start() < end for start, end in spans):
                continue
            floors.append(_years(int(match.group(1)), match.group(2)))
    return max(floors) if floors else None


def is_remote(job: dict[str, Any]) -> bool:
    insights = job.get("insights") or []
    haystack = " ".join([str(job.get("place") or ""), str(job.get("title") or ""), *map(str, insights)]).lower()
    return "remote" in haystack


def posted_at(job: dict[str, Any]) -> str | None:
    """ISO timestamp from the library's YYYY-MM-DD date, or None when it could not be parsed."""
    raw = str(job.get("date") or "").strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        return None


def to_item(job: dict[str, Any]) -> dict[str, Any] | None:
    """One /ingest item, or None when the job lacks an id, a title or a company."""
    job_id = job_id_of(job)
    title = str(job.get("title") or "").strip()
    company = str(job.get("company") or "").strip()
    if job_id is None or not title or not company:
        return None

    raw = str(job.get("description") or "")
    key = key_sentences(raw)
    # The rest of the description, minus any sentence with a "N years" figure: those are company ages and
    # tenures ("a 15 year old company"), and the Worker would read them as a requirement. The sentences that
    # really are about experience are already at the front, in `key`.
    rest = " ".join(s for s in _sentences(raw) if not (_RANGE.search(s) or _SINGLE.search(s)))
    snippet = f"{key} | {rest}" if key else rest

    item: dict[str, Any] = {
        "url": canonical_url(job_id),
        "title": title[:300],
        "company": company[:200],
        "location": str(job.get("place") or "").strip()[:300],
        "remote": is_remote(job),
        "source": "linkedin",
        "description_snippet": snippet[:SNIPPET_MAX],
    }
    when = posted_at(job)
    if when is not None:
        item["posted_at"] = when
    years = parse_min_yoe(str(job.get("description") or ""))
    if years is not None:
        item["yoe_min"] = years
    return item
