"""Logs must not contain cookies or tokens. Two layers: known secret values, and anything shaped like one."""
from __future__ import annotations

import logging
import re

MASK = "[redacted]"

# Shapes that are secret whatever their value: LinkedIn's session cookies, auth headers, the ingest key header.
_SHAPES = [
    re.compile(r"(li_at\s*[=:]\s*)[^\s;,'\"]+", re.IGNORECASE),
    re.compile(r"(li_rm\s*[=:]\s*)[^\s;,'\"]+", re.IGNORECASE),
    re.compile(r"(bcookie\s*[=:]\s*)[^\s;,'\"]+", re.IGNORECASE),
    re.compile(r"(jsessionid\s*[=:]\s*)[^\s;,'\"]+", re.IGNORECASE),
    re.compile(r"(LI_[A-Z_]*COOKIE\s*[=:]\s*)[^\s;,'\"]+"),
    re.compile(r"(x-ingest-key['\"]?\s*[=:]\s*['\"]?)[^\s;,'\"]+", re.IGNORECASE),
    re.compile(r"(authorization['\"]?\s*[=:]\s*['\"]?(?:bearer\s+)?)[^\s;,'\"]+", re.IGNORECASE),
]


def scrub(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        if len(secret) >= 6:  # a 2 character "secret" would shred ordinary words
            text = text.replace(secret, MASK)
    for shape in _SHAPES:
        text = shape.sub(lambda match: match.group(1) + MASK, text)
    return text


class Redactor(logging.Filter):
    """Attach to every handler. Rewrites the message and any traceback before it is written."""

    def __init__(self, secrets: list[str]) -> None:
        super().__init__()
        self.secrets = [secret for secret in secrets if secret]

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = scrub(record.getMessage(), self.secrets)
        record.args = ()
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = scrub(record.exc_text, self.secrets)
        return True
