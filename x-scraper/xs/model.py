from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


class AuthFailure(Exception):
    """The burner's cookies no longer log in: expired, locked, suspended or revoked."""


class FetchError(Exception):
    """X could not be read for a reason that is not authentication (rate limit, outage, library change)."""


class ConfigError(Exception):
    """A required setting is missing. The message names the setting, never its value."""


@dataclass
class RawTweet:
    """What the fetchers hand to the rest of the program. Library objects stop at fetch.py."""

    id: str
    text: str
    created_at: datetime  # timezone-aware, UTC
    url: str  # https://x.com/<user>/status/<id>
    username: str
    # Expanded URLs from the tweet's entities, in order. The text may still hold raw t.co links.
    links: list[str] = field(default_factory=list)
    is_retweet: bool = False
    is_reply: bool = False


@dataclass
class Burner:
    username: str
    cookies: str  # "auth_token=...; ct0=..."

    def as_dict(self) -> dict[str, str]:
        pairs = (part.strip().split("=", 1) for part in self.cookies.split(";") if "=" in part)
        return {name.strip(): value.strip() for name, value in pairs}
