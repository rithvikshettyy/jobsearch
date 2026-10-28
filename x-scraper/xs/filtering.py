"""Keyword filter and the tweet to /ingest item mapping. Pure."""
from __future__ import annotations

import re
from typing import Any

from .links import URL_PATTERN
from .model import RawTweet

_NON_WORD = re.compile(r"[^a-z0-9+]+")


def normalize(text: str) -> str:
    """Lowercase, punctuation to spaces: "AI/ML Engineer", "#AIEngineer" and "ai ml engineer" line up."""
    return f" {_NON_WORD.sub(' ', text.lower()).strip()} "


def matches(text: str, include: list[str], exclude: list[str]) -> tuple[bool, str]:
    """Whole-word match. A tweet needs one include phrase and no exclude phrase."""
    haystack = normalize(text)
    for phrase in exclude:
        if normalize(phrase) in haystack:
            return False, f"excluded:{phrase}"
    if not include:
        return True, "no include list"
    for phrase in include:
        if normalize(phrase) in haystack:
            return True, f"included:{phrase}"
    return False, "no include keyword"


def clean_text(text: str) -> str:
    """The tweet without its links and extra whitespace."""
    return re.sub(r"\s+", " ", URL_PATTERN.sub(" ", text)).strip()


def make_title(text: str, limit: int = 140) -> str:
    """First line of the tweet, no links, cut on a word boundary."""
    first = next((clean_text(line) for line in text.splitlines() if clean_text(line)), "")
    first = first.rstrip(" ,;:-")  # a stripped link usually leaves "Apply:" behind
    if len(first) <= limit:
        return first
    return first[:limit].rsplit(" ", 1)[0].rstrip(" ,;:-") + "..."


def to_item(tweet: RawTweet, job_url: str, company: str) -> dict[str, Any]:
    """One /ingest item. `source` is x, which the Worker treats as trusted, so this filter is the gate."""
    snippet = clean_text(tweet.text)[:1000]
    return {
        "url": job_url,
        "title": make_title(tweet.text) or "Job posting from X",
        "company": company,
        "location": "",
        "remote": False,
        "source": "x",
        "posted_at": tweet.created_at.isoformat(),
        "description_snippet": snippet,
        "tweet_url": tweet.url,
    }
