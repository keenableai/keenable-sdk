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
    from the API when it sent one.
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
