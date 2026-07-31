/**
 * `Retry-After` parsing (RFC 9110 §10.2.3).
 *
 * The header has TWO legal forms and a server may send either:
 *
 *   Retry-After: 120                              (delta-seconds)
 *   Retry-After: Wed, 21 Oct 2015 07:28:00 GMT    (HTTP-date)
 *
 * All three SDKs previously handled only the first, each wrongly and each
 * differently: Node produced `NaN` (which makes a backoff fire immediately),
 * Python raised `ValueError` from `float()` and crashed while mapping an
 * error, and Rust ignored the header entirely and retried as if the server
 * had said nothing. A rate-limited gateway therefore got hammered hardest by
 * whichever SDK you happened to be using. Found by the cross-language
 * conformance corpus (issue #75).
 *
 * Returns `undefined` for anything it cannot parse. An unusable hint means
 * "fall back to the local retry policy", never "retry now".
 */

/** Upper bound on an honoured hint: 24h. Beyond this a caller is better served by failing. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * @param value Raw header value, or null/undefined when absent.
 * @param nowMs Current epoch ms — injectable so the HTTP-date branch is
 *   testable without a virtual clock (ADR-0030a §D5 requires deterministic,
 *   non-wall-clock conformance runs).
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  // delta-seconds: RFC 9110 defines it as 1*DIGIT, so a signed, fractional or
  // exponent form is not a delta-seconds and must not be coerced into one.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return undefined;
    return clamp(seconds * 1000);
  }

  const targetMs = parseImfFixdateMs(trimmed);
  if (targetMs === undefined) return undefined;
  // A date in the past means "you may retry now", which is 0, not negative.
  return clamp(Math.max(0, targetMs - nowMs));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

/**
 * Strict IMF-fixdate (`Wed, 21 Oct 2015 07:28:00 GMT`) to epoch ms.
 *
 * Deliberately NOT `Date.parse`. Each language's platform date parser accepts
 * a different superset -- `Date.parse` takes `UTC` instead of `GMT`, lowercase
 * month names, and silently rolls `31 Feb` into March; Python's
 * `parsedate_to_datetime` rejects those but accepts trailing junk; Rust's
 * accepted a leap second and turned it into an extra minute. Three platform
 * parsers meant three different answers to the same header, which is the
 * exact failure the conformance corpus exists to prevent -- so the grammar is
 * spelled out here, identically in all three SDKs, rather than delegated.
 *
 * RFC 9110 §5.6.7 requires senders to use IMF-fixdate. The two obsolete
 * formats it allows recipients to accept are not implemented: a narrower
 * grammar the three agree on beats a wider one they disagree about.
 */
function parseImfFixdateMs(value: string): number | undefined {
  const match = IMF_FIXDATE.exec(value);
  if (!match) return undefined;
  const [, dd, mon, yyyy, hh, mm, ss] = match;
  const day = Number(dd);
  const month = MONTHS.indexOf(mon) + 1;
  const year = Number(yyyy);
  const hour = Number(hh);
  const minute = Number(mm);
  const second = Number(ss);

  // Reject rather than normalise. `31 Feb` is not a date, and a leap second
  // is not a value any gateway sends; letting either through means one SDK
  // silently rolls it forward while another refuses it.
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;

  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function clamp(ms: number): number {
  return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
}
