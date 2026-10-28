"""URL handling: tracking-param stripping, t.co and shortener expansion, picking the job link.

Pure apart from `make_http_resolver`, which is the only function that touches the network
and is injected everywhere else, so everything here tests offline.
"""
from __future__ import annotations

import re
from typing import Callable
from urllib.parse import parse_qsl, urlencode, urlsplit

Resolver = Callable[[str], "str | None"]

# Mirror of src/url.ts in the Worker. The Worker normalises again on the way in, so a
# drift here costs nothing worse than a tracking param surviving into one message.
TRACKING_PARAMS = {
    "gclid", "fbclid", "msclkid", "yclid", "igshid", "mc_cid", "mc_eid", "mkt_tok", "ref", "ref_src",
    "refid", "referrer", "source", "src", "gh_src", "trk", "trkid", "tracking", "campaign", "cmpid",
    "vero_id", "s", "t",
}
TRACKING_PREFIXES = ("utm_", "ga_", "mtm_", "pk_", "hsa_", "_hs", "li_", "lever-")

# Redirectors worth following. Anything else is left alone: fetching an arbitrary link from a
# tweet just to read its redirect would hand a stranger our IP and the click.
SHORTENERS = {
    "t.co", "bit.ly", "lnkd.in", "buff.ly", "tinyurl.com", "ow.ly", "goo.gl", "is.gd", "rb.gy",
    "shorturl.at", "cutt.ly", "t.ly", "short.io", "rebrand.ly",
}

# Not a job posting. Everything on X itself, and the usual sharing sites.
SOCIAL_HOSTS = {
    "x.com", "twitter.com", "pic.twitter.com", "t.co", "t.me", "instagram.com", "facebook.com", "fb.com",
    "youtube.com", "youtu.be", "tiktok.com", "reddit.com", "medium.com", "substack.com", "github.com",
}

# Hosts that are job boards or applicant systems, preferred when a tweet has several links.
JOB_HOST_HINTS = (
    "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com", "myworkdayjobs.com",
    "wellfound.com", "bamboohr.com", "recruitee.com", "jobvite.com", "icims.com", "careers.", "jobs.",
)

URL_PATTERN = re.compile(r"https?://[^\s<>\"']+")
TRAILING = ".,;:!?)]}'\""


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower().removeprefix("www.")


def _is_tracking(name: str) -> bool:
    key = name.lower()
    return key in TRACKING_PARAMS or key.startswith(TRACKING_PREFIXES)


def strip_tracking(url: str) -> str | None:
    """https, no www, no fragment, no tracking params, sorted params, no trailing slash. None if not http(s)."""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    host = parts.hostname.lower().removeprefix("www.")
    kept = sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _is_tracking(k))
    query = f"?{urlencode(kept)}" if kept else ""
    return f"https://{host}{parts.path.rstrip('/')}{query}"


def extract_urls(text: str) -> list[str]:
    return [match.group(0).rstrip(TRAILING) for match in URL_PATTERN.finditer(text)]


def expand_url(url: str, resolver: Resolver | None) -> str:
    """Follow a known shortener to where it lands. Any failure keeps the original."""
    if resolver is None or host_of(url) not in SHORTENERS:
        return url
    try:
        return resolver(url) or url
    except Exception:  # noqa: BLE001 - a dead short link must never stop a run
        return url


def make_http_resolver(timeout_seconds: float, max_hops: int) -> Resolver:
    """The real resolver: HEAD with redirects, up to `max_hops`. httpx is imported only here."""
    import httpx

    def resolve(url: str) -> str | None:
        with httpx.Client(follow_redirects=True, timeout=timeout_seconds, max_redirects=max_hops) as client:
            response = client.head(url)
            if response.status_code in (405, 501):  # some shorteners refuse HEAD
                with client.stream("GET", url) as streamed:
                    return str(streamed.url)
            return str(response.url)

    return resolve


def is_job_candidate(url: str) -> bool:
    host = host_of(url)
    if host == "linkedin.com" or host.endswith(".linkedin.com"):
        return urlsplit(url).path.startswith("/jobs/")
    return bool(host) and not any(host == social or host.endswith("." + social) for social in SOCIAL_HOSTS)


def pick_job_link(urls: list[str]) -> str | None:
    """The link most likely to be the posting: a job-board host first, else the first non-social link."""
    candidates = [url for url in urls if is_job_candidate(url)]
    for url in candidates:
        if any(hint in (host_of(url) + "/") for hint in JOB_HOST_HINTS):
            return url
    return candidates[0] if candidates else None


_ATS_SLUG_HOSTS = {
    "boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com",
    "apply.workable.com", "jobs.smartrecruiters.com", "careers.smartrecruiters.com",
}
_SUBDOMAIN_NOISE = {"www", "careers", "career", "jobs", "job", "apply", "hire", "hiring", "boards", "join", "work"}
_TWO_PART_TLDS = {"co.uk", "co.in", "com.au", "co.nz", "com.sg", "co.jp"}


def _pretty(slug: str) -> str:
    return re.sub(r"[-_]+", " ", slug).strip().title()


# Hosts that say nothing about who is hiring: a form or a link page, not the employer's own site.
GENERIC_HOSTS = {
    "docs.google.com", "drive.google.com", "forms.gle", "forms.office.com", "typeform.com", "airtable.com",
    "jotform.com", "tally.so", "notion.so", "notion.site", "linktr.ee", "bit.ly", "tinyurl.com", "lnkd.in",
    "linkedin.com", "t.co", "wa.me", "calendly.com",
    # Job aggregators the followed accounts promote: the page is theirs, the employer is named in the tweet.
    "joborbit.live", "joborbit.com",
}


def company_from_url(url: str) -> str:
    """A best-effort employer name. Boards that put the company in the path use it, others use the domain.

    A form or link-page host gives "Unknown" so the caller can try the tweet text instead.
    """
    parts = urlsplit(url)
    host = host_of(url)
    if any(host == generic or host.endswith("." + generic) for generic in GENERIC_HOSTS):
        return "Unknown"
    path = [segment for segment in parts.path.split("/") if segment]
    if host in _ATS_SLUG_HOSTS and path:
        return _pretty(path[0])
    if host == "wellfound.com" and len(path) >= 2 and path[0] == "company":
        return _pretty(path[1])
    if host.endswith(".myworkdayjobs.com"):
        return _pretty(host.split(".")[0])
    labels = [label for label in host.split(".") if label]
    if len(labels) < 2:
        return "Unknown"
    tail = ".".join(labels[-2:])
    registrable = labels[-3] if tail in _TWO_PART_TLDS and len(labels) >= 3 else labels[-2]
    if registrable in _SUBDOMAIN_NOISE:
        return "Unknown"
    return _pretty(registrable)
