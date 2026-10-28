"""Keyword filter and the tweet to /ingest item mapping. Pure."""
from __future__ import annotations

import html
import re
from typing import Any

from .links import URL_PATTERN
from .model import RawTweet

_NON_WORD = re.compile(r"[^a-z0-9+]+")


def normalize(text: str) -> str:
    """Lowercase, punctuation to spaces: "AI/ML Engineer", "#AIEngineer" and "ai ml engineer" line up."""
    return f" {_NON_WORD.sub(' ', html.unescape(text).lower()).strip()} "


def _has(haystack: str, phrase: str) -> bool:
    """Whole-word phrase test that also accepts a plural of the last word ("ai interns" for "ai intern")."""
    wanted = normalize(phrase)
    return wanted in haystack or f"{wanted.rstrip()}s " in haystack


def matches(text: str, include: list[str], exclude: list[str]) -> tuple[bool, str]:
    """Whole-word match. A tweet needs one include phrase and no exclude phrase."""
    haystack = normalize(text)
    for phrase in exclude:
        if _has(haystack, phrase):
            return False, f"excluded:{phrase}"
    if not include:
        return True, "no include list"
    for phrase in include:
        if _has(haystack, phrase):
            return True, f"included:{phrase}"
    return False, "no include keyword"


def clean_text(text: str) -> str:
    """The tweet without its links, HTML entities (X sends "&amp;") and extra whitespace."""
    return re.sub(r"\s+", " ", URL_PATTERN.sub(" ", html.unescape(text))).strip()


def make_title(text: str, limit: int = 140) -> str:
    """The whole tweet, links removed, cut on a word boundary.

    Job tweets from these accounts are one or two short lines ("craftAI" / "AI Engineer - FDE"),
    so the first line alone often leaves out the role.
    """
    whole = clean_text(text).rstrip(" ,;:-")  # a stripped link usually leaves "Apply:" behind
    if len(whole) <= limit:
        return whole
    return whole[:limit].rsplit(" ", 1)[0].rstrip(" ,;:-") + "..."


# Words that end a company name in "<Company> <Role> ..." tweets, and filler that sits just before the role.
_ROLE_WORDS = {
    "engineer", "engineers", "engineering", "developer", "developers", "intern", "interns", "internship",
    "scientist", "analyst", "designer", "manager", "sde", "swe", "hiring", "opening", "openings", "role",
    "roles", "position", "apply", "freshers", "fresher",
}
_FILLER = {
    "ai", "ml", "llm", "genai", "is", "are", "team", "at", "the", "a", "an", "new", "we", "we're", "were",
    "i'm", "software", "full", "stack", "fullstack", "backend", "frontend", "front", "back", "end", "data",
    "machine", "learning", "product", "applied", "forward", "deployed", "associate", "junior",
}


# "Lokal is hiring a Product Intern", "Just saw VANCO AI opened up ...": the name sits before the verb.
_SENTENCE_COMPANY = re.compile(
    r"(?:^|[:.!?]\s+|\bsaw\s+|\bat\s+)([A-Z][\w&'.]*(?:\s+[A-Z&][\w&'.]*){0,3}?)\s+(?:is hiring|are hiring|has opened|opened up|is looking for)\b"
)


def guess_company(text: str) -> str | None:
    """A company name from the tweet, for links that do not name one (a Google Form, an aggregator page).

    Two shapes are understood. A sentence ("Lokal is hiring ...", "Just saw VANCO AI opened up ...") gives the
    name before the verb. A listing ("craftAI AI Engineer - FDE") gives the words before the first role word
    or separator, with filler such as "AI" or "Software" dropped from the end. It gives up (None) unless 1 to
    4 words are left, so a wrong name is never invented.
    """
    cleaned = clean_text(text)
    sentence = _SENTENCE_COMPANY.search(cleaned)
    if sentence is not None:
        return sentence.group(1).strip(" ,.:;!#@")
    head = re.split(r"[\[\(<>|]| - | – ", cleaned, maxsplit=1)[0]
    words: list[str] = []
    for word in head.split():
        if word.lower().strip(",.:;!") in _ROLE_WORDS:
            break
        words.append(word)
    while words and words[-1].lower().strip(",.:;!") in _FILLER:
        words.pop()
    name = " ".join(words).strip(" ,.:;!#@")
    return name if name and len(words) <= 4 else None


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
