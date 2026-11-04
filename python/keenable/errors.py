"""Exceptions raised by the Keenable SDK."""

from __future__ import annotations

import json
from typing import Any


class KeenableError(Exception):
    """Base class for every error raised by this SDK."""


class KeenableConnectionError(KeenableError):
    """The Keenable API could not be reached (DNS, TLS, timeout, ...)."""


class KeenableAPIError(KeenableError):
    """The Keenable API returned a non-2xx response.

    ``status_code`` is the HTTP status and ``body`` the decoded error message
    from the API when it sent one. ``data`` is the decoded JSON error body
    when it was a JSON object, so any field the API sends stays reachable.

    A rejected domain filter arrives as HTTP 400 with
    ``{"error": "invalid_filter", "message": "Invalid include_domains value
    \"https://un.org\": scheme is not allowed", "field": "include_domains",
    "value": "https://un.org", "reason": "scheme is not allowed"}``. For that
    body ``field``, ``value`` and ``reason`` hold those keys, so code can
    react to the rejected entry without parsing the message. They are
    ``None`` on every other error.
    """

    def __init__(
        self,
        message: str,
        status_code: int,
        body: str | None = None,
        data: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.data = data
        self.field: str | None = None
        self.value: str | None = None
        self.reason: str | None = None
        if status_code == 400 and data and data.get("error") == "invalid_filter":
            self.field = _text(data.get("field"))
            self.value = _text(data.get("value"))
            self.reason = _text(data.get("reason"))


def _text(value: Any) -> str | None:
    """A structured error key as text: strings as is, other JSON re-encoded."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value)


class KeenableAuthError(KeenableAPIError):
    """The API key was rejected (HTTP 401/403)."""


class KeenableRateLimitError(KeenableAPIError):
    """The rate limit was exceeded (HTTP 429).

    Keyless requests share a lower hourly cap. Setting ``KEENABLE_API_KEY``
    lifts it; a key is never required to make a request.
    """


class KeenableInvalidRequestError(KeenableError):
    """The arguments passed to the SDK are invalid; no request was sent."""
