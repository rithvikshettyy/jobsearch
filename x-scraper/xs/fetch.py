"""Reading tweets. The ONLY module that imports twscrape or twikit.

Both adapters turn library objects into `RawTweet` straight away and keep their own quirks
inside this file. They are written against each library's public API and have NOT been run
against live X from the build environment: no burner cookies, and installing packages was not
possible there. If a library release renames a field, the fix is local to the `_to_raw`
functions below. `tests/` covers everything past this boundary.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .links import extract_urls
from .model import AuthFailure, Burner, ConfigError, FetchError, RawTweet

log = logging.getLogger("xs.fetch")

# Seconds one account may take before twscrape is assumed to be waiting on a dead account pool.
FETCH_TIMEOUT = 120

_AUTH_NAMES = ("unauthorized", "forbidden", "locked", "suspended", "notauthenticated", "loginfailed")
_AUTH_HINTS = ("401", "403", "could not authenticate", "bad guest token", "authentication", "account locked", "suspended")


def looks_like_auth_failure(exc: BaseException) -> bool:
    """Judged by name and message, so this works without importing either library's error types."""
    name = type(exc).__name__.lower()
    text = str(exc).lower()
    return any(part in name for part in _AUTH_NAMES) or any(hint in text for hint in _AUTH_HINTS)


def _utc(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def load_burners(environ: dict[str, str]) -> list[Burner]:
    """Burner accounts from X_BURNER_USERNAME / X_BURNER_COOKIES and the numbered X_BURNER_2_... pairs.

    Errors name the variable that is wrong and never print a value.
    """
    burners: list[Burner] = []
    for index in ("", "_2", "_3"):
        username = environ.get(f"X_BURNER{index}_USERNAME", "").strip()
        cookies = environ.get(f"X_BURNER{index}_COOKIES", "").strip()
        if not username and not cookies:
            continue
        if not username or not cookies:
            raise ConfigError(f"X_BURNER{index}_USERNAME and X_BURNER{index}_COOKIES must both be set")
        burner = Burner(username=username.lstrip("@"), cookies=cookies)
        missing = [name for name in ("auth_token", "ct0") if not burner.as_dict().get(name)]
        if missing:
            raise ConfigError(f"X_BURNER{index}_COOKIES is missing: {', '.join(missing)}")
        burners.append(burner)
    if not burners:
        raise ConfigError("no burner account: set X_BURNER_USERNAME and X_BURNER_COOKIES in .env")
    return burners


# ---------------------------------------------------------------------------------------------
# twscrape (primary)
# ---------------------------------------------------------------------------------------------
class TwscrapeFetcher:
    name = "twscrape"

    def __init__(self, burners: list[Burner], db_path: Path) -> None:
        self.burners = burners
        self.db_path = db_path
        self._api: Any = None

    async def _open(self) -> Any:
        if self._api is not None:
            return self._api
        from twscrape import API  # imported late: the rest of the program works without it

        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        api = API(str(self.db_path))
        for burner in self.burners:
            # Cookies make the account usable without a password login. The other fields are
            # required by the signature, not used.
            await api.pool.add_account(burner.username, "unused", f"{burner.username}@unused.invalid", "unused", cookies=burner.cookies)
        self._api = api
        return api

    async def _has_active_account(self, api: Any) -> bool:
        try:
            accounts = await api.pool.get_all()
        except Exception:  # noqa: BLE001
            return True  # cannot tell, so do not claim an auth failure
        return any(getattr(account, "active", True) for account in accounts)

    async def fetch_one(self, handle: str, since_id: str | None, limit: int) -> list[RawTweet]:
        api = await self._open()
        try:
            user = await asyncio.wait_for(api.user_by_login(handle), FETCH_TIMEOUT)
            if user is None:
                if not await self._has_active_account(api):
                    raise AuthFailure("no usable burner account in the twscrape pool")
                log.warning("twscrape: @%s was not found", handle)
                return []

            collected: list[RawTweet] = []

            async def drain() -> None:
                async for tweet in api.user_tweets(user.id, limit=limit):
                    raw = self._to_raw(tweet, handle)
                    if since_id is not None and int(raw.id) <= int(since_id):
                        break
                    collected.append(raw)

            await asyncio.wait_for(drain(), FETCH_TIMEOUT)
            return collected
        except AuthFailure:
            raise
        except asyncio.TimeoutError as exc:
            # twscrape waits for an account to free up, so a timeout with a dead pool is a login problem.
            if not await self._has_active_account(api):
                raise AuthFailure("twscrape timed out with no usable burner account") from exc
            raise FetchError(f"twscrape timed out reading @{handle}") from exc
        except Exception as exc:  # noqa: BLE001
            if looks_like_auth_failure(exc):
                raise AuthFailure(f"twscrape: {type(exc).__name__}") from exc
            raise FetchError(f"twscrape: {type(exc).__name__}: {exc}") from exc

    @staticmethod
    def _to_raw(tweet: Any, handle: str) -> RawTweet:
        text = getattr(tweet, "rawContent", None) or getattr(tweet, "content", "") or ""
        links = [getattr(link, "url", "") for link in (getattr(tweet, "links", None) or []) if getattr(link, "url", "")]
        user = getattr(tweet, "user", None)
        username = getattr(user, "username", handle) or handle
        tweet_id = str(tweet.id)
        return RawTweet(
            id=tweet_id,
            text=text,
            created_at=_utc(getattr(tweet, "date", None)),
            url=getattr(tweet, "url", None) or f"https://x.com/{username}/status/{tweet_id}",
            username=username,
            links=links,
            is_retweet=getattr(tweet, "retweetedTweet", None) is not None,
            is_reply=getattr(tweet, "inReplyToTweetId", None) is not None,
        )


# ---------------------------------------------------------------------------------------------
# twikit (fallback)
# ---------------------------------------------------------------------------------------------
class TwikitFetcher:
    name = "twikit"

    def __init__(self, burners: list[Burner]) -> None:
        self.burners = burners
        self._clients: list[Any] = []

    def _open(self) -> list[Any]:
        if self._clients:
            return self._clients
        from twikit import Client  # imported late

        for burner in self.burners:
            client = Client("en-US")
            client.set_cookies(burner.as_dict())
            self._clients.append(client)
        return self._clients

    async def fetch_one(self, handle: str, since_id: str | None, limit: int) -> list[RawTweet]:
        clients = self._open()
        last_auth: BaseException | None = None
        for client in clients:  # a second burner is tried only when the first one fails to log in
            try:
                user = await asyncio.wait_for(client.get_user_by_screen_name(handle), FETCH_TIMEOUT)
                tweets = await asyncio.wait_for(user.get_tweets("Tweets", count=limit), FETCH_TIMEOUT)
                out: list[RawTweet] = []
                for tweet in tweets:
                    raw = self._to_raw(tweet, handle)
                    if since_id is not None and int(raw.id) <= int(since_id):
                        continue
                    out.append(raw)
                return out
            except Exception as exc:  # noqa: BLE001
                if looks_like_auth_failure(exc):
                    last_auth = exc
                    continue
                raise FetchError(f"twikit: {type(exc).__name__}: {exc}") from exc
        raise AuthFailure(f"twikit: {type(last_auth).__name__ if last_auth else 'no burner'}")

    @staticmethod
    def _to_raw(tweet: Any, handle: str) -> RawTweet:
        text = getattr(tweet, "full_text", None) or getattr(tweet, "text", "") or ""
        urls = getattr(tweet, "urls", None) or []
        links = [u.get("expanded_url", "") if isinstance(u, dict) else str(u) for u in urls]
        links = [link for link in links if link]
        tweet_id = str(tweet.id)
        user = getattr(tweet, "user", None)
        username = getattr(user, "screen_name", handle) or handle
        return RawTweet(
            id=tweet_id,
            text=text,
            created_at=_utc(getattr(tweet, "created_at_datetime", None)),
            url=f"https://x.com/{username}/status/{tweet_id}",
            username=username,
            links=links,
            is_retweet=getattr(tweet, "retweeted_tweet", None) is not None,
            is_reply=bool(getattr(tweet, "in_reply_to", None)),
        )


# ---------------------------------------------------------------------------------------------
# Composite and fixture
# ---------------------------------------------------------------------------------------------
class Fetchers:
    """twscrape first, twikit when twscrape fails. AuthFailure only when every adapter says so."""

    def __init__(self, adapters: list[Any]) -> None:
        self.adapters = adapters

    async def fetch_one(self, handle: str, since_id: str | None, limit: int) -> list[RawTweet]:
        auth_failures = 0
        errors: list[str] = []
        for adapter in self.adapters:
            try:
                return await adapter.fetch_one(handle, since_id, limit)
            except AuthFailure as exc:
                auth_failures += 1
                log.warning("%s: login failed (%s)", adapter.name, exc)
            except ImportError as exc:
                errors.append(f"{adapter.name} is not installed")
                log.warning("%s unavailable: %s", adapter.name, exc)
            except FetchError as exc:
                errors.append(str(exc))
                log.warning("%s failed: %s", adapter.name, exc)
        if auth_failures == len(self.adapters):
            raise AuthFailure("every X client failed to log in")
        raise FetchError("; ".join(errors) or "no X client could read tweets")


class FixtureFetcher:
    """Reads tweets from a JSON file, for --fixture runs and tests. No network, no cookies."""

    name = "fixture"

    def __init__(self, path: Path) -> None:
        data = json.loads(path.read_text(encoding="utf-8"))
        self.redirects: dict[str, str] = data.get("redirects", {}) if isinstance(data, dict) else {}
        rows = data["tweets"] if isinstance(data, dict) else data
        self._tweets = [self._row(row) for row in rows]

    @staticmethod
    def _row(row: dict[str, Any]) -> RawTweet:
        if "hours_ago" in row:  # lets a fixture stay fresh instead of ageing out of the lookback window
            created = datetime.now(timezone.utc) - timedelta(hours=float(row["hours_ago"]))
        else:
            created = datetime.fromisoformat(str(row["created_at"]).replace("Z", "+00:00"))
        username = row.get("username", "unknown")
        return RawTweet(
            id=str(row["id"]),
            text=row["text"],
            created_at=_utc(created),
            url=row.get("url") or f"https://x.com/{username}/status/{row['id']}",
            username=username,
            links=list(row.get("links", [])),
            is_retweet=bool(row.get("is_retweet", False)),
            is_reply=bool(row.get("is_reply", False)),
        )

    async def fetch_one(self, handle: str, since_id: str | None, limit: int) -> list[RawTweet]:
        mine = [tweet for tweet in self._tweets if tweet.username.lower() == handle.lower()]
        mine.sort(key=lambda tweet: int(tweet.id), reverse=True)
        return [tweet for tweet in mine if since_id is None or int(tweet.id) > int(since_id)][:limit]

    def resolver(self, url: str) -> str | None:
        return self.redirects.get(url)


def urls_in(tweet: RawTweet) -> list[str]:
    """Every URL a tweet carries: entity links first (already expanded), then any left in the text."""
    seen: set[str] = set()
    out: list[str] = []
    for url in [*tweet.links, *extract_urls(tweet.text)]:
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out

