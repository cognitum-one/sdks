"""``Retry-After`` parsing (RFC 9110 §10.2.3).

The header has TWO legal forms and a server may send either::

    Retry-After: 120                              (delta-seconds)
    Retry-After: Wed, 21 Oct 2015 07:28:00 GMT    (HTTP-date)

All three SDKs previously handled only the first, each wrongly and each
differently: Node produced ``NaN`` (which makes a backoff fire immediately),
this SDK raised ``ValueError`` from ``float()`` and crashed *while mapping an
error*, and Rust ignored the header entirely and retried as if the server had
said nothing. A rate-limited gateway therefore got hammered hardest by
whichever SDK you happened to be using. Found by the cross-language
conformance corpus (issue #75).

Returns ``None`` for anything it cannot parse. An unusable hint means "fall
back to the local retry policy", never "retry now".
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

#: Upper bound on an honoured hint: 24h. Beyond this a caller is better served
#: by failing than by sleeping.
MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

# RFC 9110 defines delta-seconds as 1*DIGIT, so a signed, fractional or
# exponent form is not a delta-seconds and must not be coerced into one.
_DELTA_SECONDS_RE = re.compile(r"^\d+$")


def parse_retry_after_ms(value: str | None, now_ms: float | None = None) -> int | None:
    """Parse a ``Retry-After`` header into milliseconds, or ``None``.

    ``now_ms`` is injectable so the HTTP-date branch is testable without a
    wall clock (ADR-0030a §D5 requires deterministic conformance runs).
    """
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None

    if _DELTA_SECONDS_RE.match(trimmed):
        return _clamp(int(trimmed) * 1000)

    target_ms = _parse_imf_fixdate_ms(trimmed)
    if target_ms is None:
        return None

    if now_ms is None:
        import time

        now_ms = time.time() * 1000
    # A date in the past means "you may retry now", which is 0, not negative.
    return _clamp(max(0.0, target_ms - now_ms))


_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_IMF_FIXDATE_RE = re.compile(
    r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) "
    r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) "
    r"(\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$"
)


def _parse_imf_fixdate_ms(value: str) -> int | None:
    """Strict IMF-fixdate (``Wed, 21 Oct 2015 07:28:00 GMT``) to epoch ms.

    Deliberately NOT ``parsedate_to_datetime``. Each language's platform date
    parser accepts a different superset -- JavaScript's ``Date.parse`` takes
    ``UTC`` for ``GMT``, lowercase month names, and silently rolls ``31 Feb``
    into March; ``parsedate_to_datetime`` rejects those but accepts trailing
    junk; Rust's accepted a leap second and turned it into an extra minute.
    Three platform parsers meant three different answers to the same header,
    which is the exact failure the conformance corpus exists to prevent -- so
    the grammar is spelled out here, identically in all three SDKs.

    RFC 9110 §5.6.7 requires senders to use IMF-fixdate. The two obsolete
    formats it allows recipients to accept are not implemented: a narrower
    grammar the three agree on beats a wider one they disagree about.
    """
    match = _IMF_FIXDATE_RE.match(value)
    if match is None:
        return None
    day, mon, year, hour, minute, second = match.groups()
    month = _MONTHS.index(mon) + 1

    # Reject rather than normalise. `31 Feb` is not a date, and a leap second
    # is not a value any gateway sends.
    if int(hour) > 23 or int(minute) > 59 or int(second) > 59:
        return None
    try:
        target = datetime(
            int(year), month, int(day), int(hour), int(minute), int(second), tzinfo=timezone.utc
        )
    except ValueError:
        return None
    return int(target.timestamp() * 1000)


def _clamp(ms: float) -> int:
    return min(round(ms), MAX_RETRY_AFTER_MS)


__all__ = ["MAX_RETRY_AFTER_MS", "parse_retry_after_ms"]
