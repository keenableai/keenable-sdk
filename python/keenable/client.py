"""Sync and async clients for the Keenable API."""

from __future__ import annotations

import asyncio
import enum
import ipaddress
import json as jsonlib
import math
import random
import re
import time
import unicodedata
from collections.abc import Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import datetime, timezone
from os import environ
from typing import Any, Literal
from urllib.parse import unquote, urlsplit

import httpx

from ._version import __version__
from .errors import (
    KeenableAPIError,
    KeenableAuthError,
    KeenableConnectionError,
    KeenableError,
    KeenableInsufficientCreditsError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
    KeenableTimeoutError,
    RateLimitInfo,
)
from .models import Page, SearchResponse

__all__ = ["Keenable", "AsyncKeenable", "DEFAULT_MAX_RETRIES"]

DEFAULT_BASE_URL = "https://api.keenable.ai"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 2

# Retry timing, the same in the TypeScript and Go SDKs.
_INITIAL_RETRY_DELAY = 0.5
_MAX_RETRY_DELAY = 8.0
# A server-requested wait longer than this (seconds) is not waited out.
_MAX_RETRY_AFTER_WAIT = 60.0

# Endpoints are named once; the keyless variant of each is the same path with a
# `/public` suffix, so a new endpoint is one name rather than two constants.
_SEARCH = "search"
_FETCH = "fetch"

_BLOCKED_HOSTS = frozenset({"localhost", "metadata.google.internal"})
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

_STATUS_LABELS = {
    401: "Keenable authentication failed (401)",
    403: "Keenable authentication failed (403)",
    402: "Keenable: insufficient credits (402)",
    429: "Keenable rate limit exceeded (429)",
}


def _resolve_base_url(base_url: str | None) -> str:
    """Resolve and validate the API base URL, enforcing HTTPS off-localhost.

    Surrounding whitespace and trailing slashes are dropped, and a blank
    ``KEENABLE_API_URL`` counts as unset, as in the Go and TypeScript SDKs.
    """
    env = (environ.get("KEENABLE_API_URL") or "").strip()
    base = (base_url or env or DEFAULT_BASE_URL).strip().rstrip("/")
    try:
        parsed = urlsplit(base)
        host = parsed.hostname
    except ValueError:
        host = None
    if host and not parsed.query and not parsed.fragment:
        if parsed.scheme == "https":
            return base
        if parsed.scheme == "http" and _canonical_host(host) in _LOCAL_HOSTS:
            return base
    raise KeenableInvalidRequestError(
        "base_url must be an https:// URL with a host and no query or fragment "
        f"(http only to localhost, 127.0.0.1 or ::1), got {base!r}"
    )


def _canonical_host(host: str) -> str:
    """The host as a URL parser reads it: width-folded, lowercased, no final dot.

    Browsers, Node and the TypeScript SDK fold fullwidth characters and
    ideographic full stops (``１２７。０。０。１`` is 127.0.0.1), so this check
    has to see the host the same way.
    """
    folded = unicodedata.normalize("NFKC", host)
    for stop in _IDEOGRAPHIC_STOPS:
        folded = folded.replace(stop, ".")
    # IDNA mapping deletes these, so "local\u00adhost" is localhost to a
    # WHATWG parser (and to the TypeScript SDK).
    for ignored in _IDNA_IGNORED:
        folded = folded.replace(ignored, "")
    return folded.strip().lower().rstrip(".")


_IDEOGRAPHIC_STOPS = ("\u3002", "\uff0e", "\uff61")
_IDNA_IGNORED = ("\u00ad", "\u200b", "\u2060", "\ufeff")


def _numeric_ipv4(host: str) -> ipaddress.IPv4Address | None:
    """The IPv4 address a host spelled as numbers names, as a URL parser reads it.

    ``2130706433``, ``0x7f.1``, ``0177.0.0.1`` and ``127.1`` all reach
    127.0.0.1 in a browser or Node (and the TypeScript SDK refuses them), but
    ``ipaddress`` only knows the dotted-decimal spelling. Each part is decimal,
    ``0x`` hex or ``0``-prefixed octal; the last fills the remaining bytes.
    """
    parts = host.split(".")
    if not 1 <= len(parts) <= 4:
        return None
    numbers: list[int] = []
    for part in parts:
        if part[:2] in ("0x", "0X"):
            digits, base, allowed = part[2:], 16, "0123456789abcdefABCDEF"
        elif len(part) > 1 and part[0] == "0":
            digits, base, allowed = part[1:], 8, "01234567"
        else:
            digits, base, allowed = part, 10, "0123456789"
        if not part or not all(c in allowed for c in digits):
            return None
        # Over 11 significant digits is past 2**32 in any base; checking first
        # keeps int() clear of Python's integer-string length limit.
        digits = digits.lstrip("0")
        if len(digits) > 11:
            return None
        numbers.append(int(digits, base) if digits else 0)
    *leading, last = numbers
    if any(n > 255 for n in leading) or last >= 256 ** (4 - len(leading)):
        return None
    value = last
    for index, number in enumerate(leading):
        value += number << (8 * (3 - index))
    return ipaddress.IPv4Address(value)


# The ranges fetch() refuses, the same list in every SDK (see
# scripts/conformance/README.md). Written out rather than read from
# ipaddress's is_private and is_reserved, which change between Python versions.
_BLOCKED_IPV4 = tuple(
    ipaddress.IPv4Network(net)
    for net in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
    )
)
# IPv6 outside 2000::/3 is refused, and so are these special blocks inside it.
_GLOBAL_IPV6 = ipaddress.IPv6Network("2000::/3")
_BLOCKED_IPV6 = tuple(
    ipaddress.IPv6Network(net)
    for net in ("2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20")
)

_FETCH_SCHEME = re.compile(r"(?i)https?://")
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped
        if mapped is None:
            return ip not in _GLOBAL_IPV6 or any(ip in net for net in _BLOCKED_IPV6)
        ip = mapped
    return any(ip in net for net in _BLOCKED_IPV4)


def _reject_private_fetch_target(url: Any) -> None:
    """Refuse obviously internal fetch targets before a request leaves the host.

    The backend enforces this too, but stopping here keeps an internal hostname
    out of an outbound request in the first place. The rules are shared with
    the Go and TypeScript SDKs (scripts/conformance/README.md).
    """
    if not isinstance(url, str):
        raise KeenableInvalidRequestError(
            f"fetch() needs a URL string, got {type(url).__name__}"
        )
    if _CONTROL_CHARS.search(url) or url[:1] == " " or url[-1:] == " ":
        raise KeenableInvalidRequestError(
            f"fetch() URL has a control character or surrounding space: {url!r}"
        )
    # Exactly "scheme://": WHATWG parsers read "https:host", "https:/host" and
    # "https:\\host" as https://host/, where this parser sees no host at all.
    scheme = _FETCH_SCHEME.match(url)
    if scheme is None:
        raise KeenableInvalidRequestError(f"fetch() needs an http(s) URL, got {url!r}")
    # A backslash in the authority makes WHATWG and RFC 3986 parsers disagree
    # on the host: https://127.0.0.1\@example.com is 127.0.0.1 to one of them.
    authority = re.split(r"[/?#]", url[scheme.end() :], maxsplit=1)[0]
    if "\\" in authority:
        raise KeenableInvalidRequestError(
            f"fetch() URL has a backslash in its host: {url!r}"
        )
    try:
        hostname = urlsplit(url).hostname or ""
    except ValueError as exc:
        raise KeenableInvalidRequestError(f"fetch() URL is not valid: {url!r}") from exc

    # Percent-decoded as a URL parser decodes a host; a trailing dot resolves
    # to the same host but does not match it as a string.
    host = _canonical_host(unquote(hostname))
    if ":" in host:
        host = host.split("%", 1)[0]  # an IPv6 zone
    if not host:
        raise KeenableInvalidRequestError(f"fetch() URL has no host: {url!r}")
    if host in _BLOCKED_HOSTS or host.endswith(".localhost"):
        raise KeenableInvalidRequestError(f"refusing to fetch internal host {host!r}")
    ip: ipaddress.IPv4Address | ipaddress.IPv6Address | None
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = _numeric_ipv4(host)
        if ip is None:
            return  # A hostname; the backend's SSRF guard is the backstop.
    if _is_blocked_ip(ip):
        raise KeenableInvalidRequestError(f"refusing to fetch private address {host!r}")


def _search_payload(query: str, mode: str | None, **filters: Any) -> dict[str, Any]:
    """Build the search request body, dropping filters the caller left unset."""
    if not isinstance(query, str) or not query.strip():
        raise KeenableInvalidRequestError("search() needs a non-empty query string")

    payload: dict[str, Any] = {"query": query, "mode": mode or "pro"}
    # An empty string is unset, as in Go, which cannot tell the two apart.
    payload.update(
        {
            name: value
            for name, value in filters.items()
            if value is not None and value != ""
        }
    )
    return payload


def _domain_list(value: Sequence[str] | None) -> Any:
    if value is None or isinstance(value, (str, Mapping)):
        return value
    if not isinstance(value, Iterable):
        return value
    return list(value)


# Codes about the page being fetched rather than about Keenable or the caller,
# besides every ``target_*`` code. Servers before error format v1 send no
# ``type``, so it is derived from these and the status.
_TARGET_CODES = frozenset({"page_not_found", "content_not_extracted"})


def _derive_type(status: int, code: str | None) -> str:
    """The error ``type`` for a response that did not send one.

    Matches the API's catalog for every code it had when ``type`` was added.
    """
    if code and (code.startswith("target_") or code in _TARGET_CODES):
        return "target_error"
    if status == 401:
        return "authentication_error"
    if status == 403:
        return "permission_error"
    if status in (402, 451):
        return "billing_error"
    if status == 429:
        return "rate_limit_error"
    if 400 <= status < 500:
        return "invalid_request_error"
    return "api_error"


def _str_field(body: dict[str, Any], key: str) -> str | None:
    value = body.get(key)
    return value if isinstance(value, str) and value.strip() else None


# The longest Retry-After delay reported, in seconds (a year).
_MAX_RETRY_AFTER = 365 * 24 * 60 * 60


def _seconds(value: Any) -> float | None:
    """A non-negative, finite number of seconds capped at a year, else None.

    An integer too large for a float is treated like the non-finite number
    the Go and TypeScript SDKs see for it, and dropped, so the next source of
    the delay is used; ``math.isfinite`` would raise OverflowError on it.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        seconds = float(value)
    except OverflowError:
        return None
    if not math.isfinite(seconds) or seconds < 0:
        return None
    if seconds > _MAX_RETRY_AFTER:
        return _MAX_RETRY_AFTER
    # The value itself, so an integer delay stays an int.
    exact: float = value
    return exact


_WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_LONG_WEEKDAYS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)
_MONTHS = (
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
)
# The three HTTP-date forms of RFC 9110 section 5.6.7, as Go's http.ParseTime
# reads them: IMF-fixdate, RFC 850 and asctime. Names match in any case; the
# zone is GMT. A numeric or missing zone is not an HTTP date.
_IMF_FIXDATE = re.compile(
    r"((?i:[a-z]{3})), (\d\d) ((?i:[a-z]{3})) (\d{4}) (\d\d):(\d\d):(\d\d) GMT",
    re.ASCII,
)
_RFC_850 = re.compile(
    r"((?i:[a-z]{6,9})), (\d\d)-((?i:[a-z]{3}))-(\d\d) (\d\d):(\d\d):(\d\d) GMT",
    re.ASCII,
)
_ASCTIME = re.compile(
    r"((?i:[a-z]{3})) ((?i:[a-z]{3})) ( \d|\d\d?) (\d\d):(\d\d):(\d\d) (\d{4})",
    re.ASCII,
)


def _http_date(text: str) -> datetime | None:
    """An RFC 9110 HTTP-date in UTC, or None for anything else.

    The weekday must be a weekday name but is not checked against the date.
    """
    weekdays = _WEEKDAYS
    if match := _IMF_FIXDATE.fullmatch(text):
        weekday, day, month, year, hour, minute, second = match.groups()
    elif match := _RFC_850.fullmatch(text):
        weekday, day, month, short_year, hour, minute, second = match.groups()
        # Two-digit years: 69 to 99 are 19xx, as Go's time.Parse reads them.
        year = str((1900 if int(short_year) >= 69 else 2000) + int(short_year))
        weekdays = _LONG_WEEKDAYS
    elif match := _ASCTIME.fullmatch(text):
        weekday, month, day, hour, minute, second, year = match.groups()
    else:
        return None
    if weekday.lower() not in weekdays or month.lower() not in _MONTHS:
        return None
    try:
        return datetime(
            int(year),
            _MONTHS.index(month.lower()) + 1,
            int(day),
            int(hour),
            int(minute),
            int(second),
            tzinfo=timezone.utc,
        )
    except ValueError:  # Day, hour, minute or second out of range.
        return None


def _retry_after_header(value: str | None, now: datetime | None = None) -> float | None:
    """Parse a Retry-After header: delay-seconds or an RFC 9110 HTTP date.

    ``now`` is when a date is measured from; tests pin it.
    """
    if not value or not value.strip():
        return None
    text = value.strip()
    if text.isascii() and text.isdigit():
        # Cap at a year, as the Go SDK does; checking the length first keeps
        # int() clear of Python's integer-string length limit. Leading zeros
        # do not count: "0000000001" is one second.
        text = text.lstrip("0") or "0"
        if len(text) > len(str(_MAX_RETRY_AFTER)):
            return _MAX_RETRY_AFTER
        return min(int(text), _MAX_RETRY_AFTER)
    when = _http_date(text)
    if when is None:
        return None
    delay = math.ceil((when - (now or datetime.now(timezone.utc))).total_seconds())
    return min(max(0, delay), _MAX_RETRY_AFTER)


def _limit_info(value: Any) -> RateLimitInfo | None:
    if not isinstance(value, dict):
        return None
    return RateLimitInfo(
        scope=_str_field(value, "scope"),
        window=_str_field(value, "window"),
        max=_limit_max(value.get("max")),
        resets_at=_str_field(value, "resets_at"),
    )


# The largest integer every SDK reads exactly: TypeScript's numbers are doubles.
_MAX_SAFE_INTEGER = 2**53 - 1


def _limit_max(value: Any) -> int | None:
    """A whole number from 0 to 2**53 - 1, else None. ``1000.0`` is 1000."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None  # Also NaN and infinity.
    if not 0 <= value <= _MAX_SAFE_INTEGER:
        return None
    return int(value)


def _error_fields(
    raw: dict[str, Any] | None, response: httpx.Response
) -> dict[str, Any]:
    """The agent-ready fields of an error body, None where the API left one out.

    The docs link, billing and top-up URLs and x402 payment offers a body may
    carry are not read: the SDK does not expose them.

    ``retry_after_seconds`` prefers the body, then the ``Retry-After`` header,
    then the older ``retryAfter`` body field; ``request_id`` prefers the body,
    then the ``X-Request-Id`` header; ``type`` is derived from the status and
    code when the API did not send it.
    """
    body = raw or {}
    retryable = body.get("retryable")
    retry_after = _seconds(body.get("retry_after_seconds"))
    if retry_after is None:
        retry_after = _retry_after_header(response.headers.get("Retry-After"))
    if retry_after is None:
        retry_after = _seconds(body.get("retryAfter"))
    header_id = (response.headers.get("X-Request-Id") or "").strip() or None
    code = _str_field(body, "code")
    invalid_filter = (
        response.status_code == 400 and body.get("error") == "invalid_filter"
    )
    return {
        "code": code,
        "type": _str_field(body, "type") or _derive_type(response.status_code, code),
        "error": _str_field(body, "error"),
        "fix": _str_field(body, "fix"),
        "retryable": retryable if isinstance(retryable, bool) else None,
        "retry_after_seconds": retry_after,
        "request_id": _str_field(body, "request_id") or header_id,
        "param": _str_field(body, "param"),
        "limit": _limit_info(body.get("limit")),
        "value": _str_field(body, "value") if invalid_filter else None,
        "reason": _str_field(body, "reason") if invalid_filter else None,
    }


def _sentence(message: str, more: str) -> str:
    """Append ``more`` as a new sentence, without doubling a final period."""
    return f"{message}{' ' if message.endswith('.') else '. '}{more}"


def _parse_json(content: bytes) -> Any:
    """Decode a JSON body as the Go and TypeScript SDKs do, or raise ValueError.

    Invalid UTF-8 is replaced rather than fatal and a leading byte order mark
    is ignored, as in a browser's ``response.text()``. ``NaN`` and
    ``Infinity`` are not JSON, although Python's parser takes them.
    """
    text = content.decode("utf-8", errors="replace")
    if text.startswith("\ufeff"):
        text = text[1:]
    if _nested_too_deeply(text):
        raise ValueError("JSON nested too deeply")
    try:
        return jsonlib.loads(text, parse_constant=_reject_constant)
    except RecursionError as exc:  # Nesting too deep for this interpreter.
        raise ValueError("JSON nested too deeply") from exc


# Nesting deeper than this is "not JSON" in all three SDKs (scripts/conformance),
# whatever the interpreter's own recursion limit is.
_MAX_JSON_DEPTH = 512


def _nested_too_deeply(text: str) -> bool:
    """Whether a JSON-looking body nests arrays/objects deeper than the limit.

    Only a body that starts like JSON and has enough brackets is walked, and
    the walk stops at the first level past the limit, so HTML and other error
    pages cost one count.
    """
    if text.lstrip()[:1] not in ("[", "{"):
        return False
    if text.count("[") + text.count("{") <= _MAX_JSON_DEPTH:
        return False
    depth = 0
    in_string = escaped = False
    for ch in text:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch in "[{":
            depth += 1
            if depth > _MAX_JSON_DEPTH:
                return True
        elif ch in "]}":
            depth -= 1
    return False


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


# A 402's message is the SDK's own: the API's text links to billing pages and
# payment offers, which the SDK does not expose.
_PAYMENT_REQUIRED = (
    "Keenable: payment required (402). This SDK does not pay per request: "
    "set KEENABLE_API_KEY to call the API with a key instead."
)
_INSUFFICIENT_CREDITS = (
    "Keenable: insufficient credits (402). The organization is out of credits; "
    "retrying fails the same way until a human with console access adds more."
)


def _is_payment_offer(code: str | None, body: dict[str, Any] | None) -> bool:
    """Whether a 402 asks to pay per request (x402) rather than for credits."""
    if code is not None and code.startswith("payment_"):
        return True
    return body is not None and ("accepts" in body or "x402Version" in body)


def _to_api_error(response: httpx.Response) -> KeenableAPIError:
    """Map a non-2xx response to the most specific SDK error available."""
    detail = ""
    body: dict[str, Any] | None = None
    try:
        decoded = _parse_json(response.content)
    except ValueError:
        detail = (response.text or "").strip()
    else:
        # JSON that is not an object has no fields and no detail.
        if isinstance(decoded, dict):
            body = decoded
            # The first that is a string with more than whitespace, as Go and
            # TypeScript pick it; other types are skipped, not stringified.
            for key in ("message", "error", "detail"):
                text = body.get(key)
                if isinstance(text, str) and text.strip():
                    detail = text
                    break

    fields = _error_fields(body, response)
    status = response.status_code
    # A 401/403 about the page being fetched is not an authentication failure.
    auth = status in (401, 403) and fields["type"] != "target_error"
    if status == 402:
        message = (
            _PAYMENT_REQUIRED
            if _is_payment_offer(fields["code"], body)
            else _INSUFFICIENT_CREDITS
        )
    else:
        if status in (401, 403) and not auth:
            label = f"Keenable API error ({status})"
        else:
            label = _STATUS_LABELS.get(status, f"Keenable API error ({status})")
        message = f"{label}: {detail}" if detail else label
        if fields["fix"]:
            # The API's next step, appended the same way in the Go and TS SDKs.
            message = _sentence(message, fields["fix"])
    # What to quote, as Stripe's SDKs print it; the same tail as the Go and TS
    # SDKs. The code goes in its own parentheses so the "(request_id: ...)" Go
    # has shipped reads the same everywhere.
    if fields["code"]:
        message = f"{message} (code: {fields['code']})"
    if fields["request_id"]:
        message = f"{message} (request_id: {fields['request_id']})"

    if auth:
        return KeenableAuthError(message, status, detail or None, **fields)
    if status == 402:
        return KeenableInsufficientCreditsError(
            message, status, detail or None, **fields
        )
    if status == 429:
        return KeenableRateLimitError(message, status, detail or None, **fields)
    return KeenableAPIError(message, status, detail or None, **fields)


class _RedirectError(KeenableConnectionError):
    """A redirect this SDK refused to follow; retrying would refuse it again."""


def _decode(response: httpx.Response) -> tuple[dict[str, Any], str | None]:
    """Validate the status and decode a JSON object body, with the request id."""
    if response.is_redirect or 300 <= response.status_code < 400:
        location = response.headers.get("Location")
        where = f" to {location}" if location else ""
        raise _RedirectError(
            f"the Keenable API redirected{where}. The redirect was not followed, "
            "so the API key was not sent. Check KEENABLE_API_URL."
        )
    if not response.is_success:
        raise _to_api_error(response)
    request_id = (response.headers.get("X-Request-Id") or "").strip() or None
    try:
        data = _parse_json(response.content)
    except ValueError as exc:
        snippet = (response.text or "")[:200]
        raise KeenableAPIError(
            f"Keenable API returned a non-JSON response: {snippet!r}",
            response.status_code,
            request_id=request_id,
        ) from exc
    if not isinstance(data, dict):
        raise KeenableAPIError(
            f"Unexpected response from the Keenable API: {data!r}",
            response.status_code,
            request_id=request_id,
        )
    return data, request_id


@contextmanager
def _transport_errors(timeout: Any) -> Iterator[None]:
    """Translate httpx transport failures into a KeenableConnectionError.

    Wrapping the ``await`` inside the ``with`` body works for the async client
    too, so both clients share one definition of "could not reach the API".
    """
    try:
        yield
    except httpx.TimeoutException as exc:
        within = f" within {timeout} s" if isinstance(timeout, (int, float)) else ""
        raise KeenableTimeoutError(
            f"the Keenable API did not respond{within}: {exc!r}"
        ) from exc
    except httpx.HTTPError as exc:
        raise KeenableConnectionError(
            f"could not reach the Keenable API: {exc!r}"
        ) from exc


def _backoff(retry: int, jitter: float | None = None) -> float:
    """The exponential backoff in seconds before retry number ``retry`` (0 first).

    0.5 s doubling up to 8 s, shortened by up to 25% of jitter so clients that
    failed together do not retry together. Kept in step with TS and Go.
    """
    # The exponent stops at 5 (16 s, past the cap): 2.0**1024 overflows a
    # float and would raise OverflowError on a long retry budget.
    base = min(_INITIAL_RETRY_DELAY * 2.0 ** min(retry, 5), _MAX_RETRY_DELAY)
    return base * (1 - 0.25 * (random.random() if jitter is None else jitter))


def _retry_delay(error: Exception, retry: int) -> float | None:
    """Seconds to wait before retrying after ``error``, or None not to retry.

    The API's ``retryable`` decides when it sent one; otherwise 408, 429 and
    5xx are retried, and so are network failures and timeouts. A
    ``Retry-After`` over a minute is not waited out.
    """
    if isinstance(error, KeenableAPIError):
        status = error.status_code
        retryable = error.retryable
        if retryable is None:
            retryable = status in (408, 429) or status >= 500
        if not retryable:
            return None
        if error.retry_after_seconds is not None:
            wait = float(error.retry_after_seconds)
            return wait if wait <= _MAX_RETRY_AFTER_WAIT else None
        return _backoff(retry)
    if isinstance(error, _RedirectError):
        return None
    if isinstance(error, KeenableConnectionError):
        return _backoff(retry)
    return None


def _check_max_retries(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise KeenableInvalidRequestError(
            f"max_retries must be a non-negative integer, got {value!r}"
        )
    return value


class _Unset(enum.Enum):
    """Marks a ``timeout`` the caller did not pass, as distinct from ``None``."""

    TOKEN = 0


_UNSET = _Unset.TOKEN


def _check_client_timeout(value: Any) -> Any:
    """Validate a timeout: ``None`` (no deadline) and ``httpx.Timeout`` pass."""
    if value is None or isinstance(value, httpx.Timeout):
        return value
    return _check_timeout(value)


# The longest timeout honoured, in seconds: the longest a JavaScript timer can
# wait, so the TypeScript SDK can keep it too. Longer ones are treated as this
# (a socket timeout past a C timeval would raise OverflowError anyway).
_MAX_TIMEOUT = 2_147_483.647


def _check_timeout(value: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise KeenableInvalidRequestError(
            f"timeout must be a positive number of seconds, got {value!r}"
        )
    return min(value, _MAX_TIMEOUT)


# An HTTP header name is a token (RFC 9110 section 5.6.2).
_HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")


def _check_headers(headers: Mapping[str, str], where: str) -> dict[str, str]:
    """Refuse a header httpx would fail to send, before anything is sent.

    Otherwise the failure is a transport error, which is retried although it
    can never succeed.
    """
    for name, value in headers.items():
        if not isinstance(name, str) or not _HEADER_NAME.fullmatch(name):
            raise KeenableInvalidRequestError(
                f"{where} has an invalid header name: {name!r}"
            )
        if not isinstance(value, str) or any(c in value for c in "\r\n\x00"):
            raise KeenableInvalidRequestError(
                f"{where} has an invalid value for {name!r}: a header value is a "
                "string without CR, LF or NUL"
            )
    return dict(headers)


class _BaseClient:
    """Shared configuration for the sync and async clients."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float | httpx.Timeout | None = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        client_source: str = "Keenable SDK",
    ) -> None:
        key = api_key if api_key is not None else environ.get("KEENABLE_API_KEY")
        self._api_key = (key or "").strip() or None
        self._base_url = _resolve_base_url(base_url)
        self._client_source = client_source
        self._timeout: Any = _check_client_timeout(timeout)
        self._max_retries = _check_max_retries(max_retries)
        self._default_headers = _check_headers(default_headers or {}, "default_headers")

    @property
    def keyless(self) -> bool:
        """True when no API key is configured and the public tier is in use."""
        return self._api_key is None

    def _headers(
        self, extra: Mapping[str, str] | None = None, *, json: bool = False
    ) -> httpx.Headers:
        """The SDK's headers, then ``default_headers``, then the call's.

        The API key is always the configured one, so a stray header cannot
        send a different key or turn a keyless call keyed.
        """
        headers = httpx.Headers(
            {
                "Accept": "application/json",
                "User-Agent": f"keenable-python/{__version__}",
                # The public tier rejects requests without this header.
                "X-Keenable-Title": self._client_source,
            }
        )
        for source in (
            self._default_headers,
            _check_headers(extra or {}, "extra_headers"),
        ):
            for name, value in source.items():
                if name.lower() != "x-api-key":
                    headers[name] = value
        if self._api_key is not None:
            headers["X-API-Key"] = self._api_key
        if json:
            headers["Content-Type"] = "application/json"
        return headers

    def _url(self, endpoint: str) -> str:
        """The endpoint URL, keyless or keyed depending on the configured key."""
        suffix = "/public" if self.keyless else ""
        return f"{self._base_url}/v1/{endpoint}{suffix}"

    def _call_settings(
        self, timeout: float | httpx.Timeout | None, max_retries: int | None
    ) -> tuple[Any, int]:
        """The per-call timeout (or the client's) and retry budget."""
        call_timeout: Any = (
            _check_client_timeout(timeout)
            if timeout is not None
            else self._call_default_timeout()
        )
        retries = (
            _check_max_retries(max_retries)
            if max_retries is not None
            else self._max_retries
        )
        return call_timeout, retries

    def _call_default_timeout(self) -> Any:
        return self._timeout


class Keenable(_BaseClient):
    """Synchronous client for the Keenable web search API.

    Keyless by default: with no API key the client calls the public endpoints,
    which are rate limited per hour. Pass ``api_key`` (or set
    ``KEENABLE_API_KEY``) to lift that limit. Create a key at
    https://keenable.ai/console.

    Example:
        >>> from keenable import Keenable
        >>> keenable = Keenable()
        >>> results = keenable.search("cerebras inference benchmarks")
        >>> print(results.to_context())

    The client can be reused across calls and is safe to keep for the lifetime
    of your process. Use it as a context manager (or call :meth:`close`) to
    release the underlying connection pool.

    Args:
        api_key: Falls back to ``KEENABLE_API_KEY``; omit it for the free tier.
        base_url: Falls back to ``KEENABLE_API_URL``.
        timeout: Deadline in seconds for each attempt, or an
            ``httpx.Timeout``; ``None`` means no deadline. With your own
            ``client``, that client's timeout applies unless you pass this.
        max_retries: How many times to retry a failed request (default 2,
            ``0`` turns retries off). Connection errors, timeouts, 408, 429
            and 5xx are retried, unless the API says the error is not
            retryable. The wait is the API's ``Retry-After`` when it sent one,
            else exponential backoff from 0.5 s to 8 s with jitter. A
            ``Retry-After`` over 60 s (such as the keyless hourly cap) is not
            waited out: the error is raised at once.
        default_headers: Headers sent with every request.
        client_source: Name this client reports as its traffic source. Leave it
            alone unless you are building an integration on top of this SDK and
            want your own attribution.
        client: Bring your own ``httpx.Client`` (proxies, transport).
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float | httpx.Timeout | None | _Unset = _UNSET,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        client_source: str = "Keenable SDK",
        client: httpx.Client | None = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=DEFAULT_TIMEOUT if isinstance(timeout, _Unset) else timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            client_source=client_source,
        )
        # A client you pass keeps its own timeout unless you set one here.
        self._use_client_timeout = client is not None and isinstance(timeout, _Unset)
        self._client = client or httpx.Client(timeout=self._timeout)
        self._owns_client = client is None

    def _call_default_timeout(self) -> Any:
        return httpx.USE_CLIENT_DEFAULT if self._use_client_timeout else self._timeout

    def __enter__(self) -> Keenable:
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        if self._owns_client:
            self._client.close()

    def _request(
        self,
        endpoint: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> tuple[dict[str, Any], str | None]:
        """Send a request, retrying what can be retried, and decode the body.

        Every transport concern lives here: endpoint selection, headers,
        timeout, retries, error translation and decoding.
        """
        call_timeout, retries = self._call_settings(timeout, max_retries)
        headers = self._headers(extra_headers, json=json is not None)
        retry = 0
        while True:
            try:
                with _transport_errors(call_timeout):
                    response = self._client.request(
                        "GET" if json is None else "POST",
                        self._url(endpoint),
                        params=params,
                        json=json,
                        headers=headers,
                        timeout=call_timeout,
                        # Never follow: httpx would carry X-API-Key to the
                        # host a redirect names.
                        follow_redirects=False,
                    )
                return _decode(response)
            except KeenableError as error:
                delay = _retry_delay(error, retry) if retry < retries else None
                if delay is None:
                    raise
                time.sleep(delay)
                retry += 1

    def search(
        self,
        query: str,
        *,
        mode: Literal["pro"] | None = None,
        site: str | None = None,
        exclude_domains: Sequence[str] | None = None,
        published_after: str | None = None,
        published_before: str | None = None,
        acquired_after: str | None = None,
        acquired_before: str | None = None,
        snippet_max_length: int | None = None,
        max_results: int | None = None,
        query_time: str | None = None,
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> SearchResponse:
        """Search the web and return ranked results with page text.

        Args:
            query: What to look for. Describe the ideal page in natural
                language ("blog post comparing React and Vue performance")
                rather than typing keywords; the index is semantic.
            mode: Search mode. ``"pro"`` (the default) does deeper retrieval.
            site: Restrict results to one domain, e.g. ``"arxiv.org"``.
            exclude_domains: Never return results from these hosts and their
                subdomains.
            published_after: Keep pages published on or after ``YYYY-MM-DD``.
            published_before: Keep pages published on or before ``YYYY-MM-DD``.
            acquired_after: Keep pages Keenable indexed on or after
                ``YYYY-MM-DD``. Use this for "what is new since ..." queries,
                where the publication date is unreliable or missing.
            acquired_before: Keep pages indexed on or before ``YYYY-MM-DD``.
            snippet_max_length: Cap the characters of page text per result.
            max_results: How many results to return, 1 to 50. The API
                default is 10.
            query_time: Search the index as it stood at this moment; pages
                newer than it are excluded. It sets no lower bound, so it is
                not a recency filter: use ``published_after`` for that.
                Accepts an ISO 8601 datetime, ``YYYY-MM-DD``, or an offset
                back from now such as ``"7d"`` (as of 7 days ago).
            timeout: Deadline in seconds (or an ``httpx.Timeout``) for each
                attempt of this call. ``None`` keeps the client's timeout.
            max_retries: Retry budget for this call; ``0`` turns retries off.
            extra_headers: Headers for this call, over ``default_headers``.

        Returns:
            A :class:`SearchResponse`; iterate it for results or call
            :meth:`SearchResponse.to_context` to build a prompt block.
        """
        payload = _search_payload(
            query,
            mode,
            site=site,
            exclude_domains=_domain_list(exclude_domains),
            published_after=published_after,
            published_before=published_before,
            acquired_after=acquired_after,
            acquired_before=acquired_before,
            snippet_max_length=snippet_max_length,
            max_results=max_results,
            query_time=query_time,
        )
        body, request_id = self._request(
            _SEARCH,
            json=payload,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )
        return SearchResponse._from_json(body, query, request_id)

    def fetch(
        self,
        url: str,
        *,
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Page:
        """Fetch one URL and return its main content as markdown.

        Use this after :meth:`search` when a snippet is not enough and the
        model needs the full page. ``timeout``, ``max_retries`` and
        ``extra_headers`` apply to this call only, as in :meth:`search`.
        """
        _reject_private_fetch_target(url)
        body, request_id = self._request(
            _FETCH,
            params={"url": url},
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )
        return Page._from_json(body, url, request_id)


class AsyncKeenable(_BaseClient):
    """Asynchronous client for the Keenable web search API.

    Mirrors :class:`Keenable` with awaitable methods and the same arguments.

    Example:
        >>> import asyncio
        >>> from keenable import AsyncKeenable
        >>> async def main():
        ...     async with AsyncKeenable() as keenable:
        ...         results = await keenable.search("wafer scale engine")
        ...         print(results.to_context())
        >>> asyncio.run(main())
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float | httpx.Timeout | None | _Unset = _UNSET,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        client_source: str = "Keenable SDK",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=DEFAULT_TIMEOUT if isinstance(timeout, _Unset) else timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            client_source=client_source,
        )
        self._use_client_timeout = client is not None and isinstance(timeout, _Unset)
        self._client = client or httpx.AsyncClient(timeout=self._timeout)
        self._owns_client = client is None

    def _call_default_timeout(self) -> Any:
        return httpx.USE_CLIENT_DEFAULT if self._use_client_timeout else self._timeout

    async def __aenter__(self) -> AsyncKeenable:
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the underlying HTTP connection pool."""
        if self._owns_client:
            await self._client.aclose()

    async def _request(
        self,
        endpoint: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> tuple[dict[str, Any], str | None]:
        """Async counterpart of :meth:`Keenable._request`."""
        call_timeout, retries = self._call_settings(timeout, max_retries)
        headers = self._headers(extra_headers, json=json is not None)
        retry = 0
        while True:
            try:
                with _transport_errors(call_timeout):
                    response = await self._client.request(
                        "GET" if json is None else "POST",
                        self._url(endpoint),
                        params=params,
                        json=json,
                        headers=headers,
                        timeout=call_timeout,
                        follow_redirects=False,
                    )
                return _decode(response)
            except KeenableError as error:
                delay = _retry_delay(error, retry) if retry < retries else None
                if delay is None:
                    raise
                await asyncio.sleep(delay)
                retry += 1

    async def search(
        self,
        query: str,
        *,
        mode: Literal["pro"] | None = None,
        site: str | None = None,
        exclude_domains: Sequence[str] | None = None,
        published_after: str | None = None,
        published_before: str | None = None,
        acquired_after: str | None = None,
        acquired_before: str | None = None,
        snippet_max_length: int | None = None,
        max_results: int | None = None,
        query_time: str | None = None,
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> SearchResponse:
        """Search the web. See :meth:`Keenable.search` for the arguments."""
        payload = _search_payload(
            query,
            mode,
            site=site,
            exclude_domains=_domain_list(exclude_domains),
            published_after=published_after,
            published_before=published_before,
            acquired_after=acquired_after,
            acquired_before=acquired_before,
            snippet_max_length=snippet_max_length,
            max_results=max_results,
            query_time=query_time,
        )
        body, request_id = await self._request(
            _SEARCH,
            json=payload,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )
        return SearchResponse._from_json(body, query, request_id)

    async def fetch(
        self,
        url: str,
        *,
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Page:
        """Fetch one URL as markdown. See :meth:`Keenable.fetch`."""
        _reject_private_fetch_target(url)
        body, request_id = await self._request(
            _FETCH,
            params={"url": url},
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )
        return Page._from_json(body, url, request_id)
