"""Exceptions raised by the Keenable SDK."""

from __future__ import annotations


class KeenableError(Exception):
    """Base class for every error raised by this SDK."""


class KeenableConnectionError(KeenableError):
    """The Keenable API could not be reached (DNS, TLS, timeout, ...)."""


class KeenableAPIError(KeenableError):
    """The Keenable API returned a non-2xx response.

    ``status_code`` is the HTTP status and ``body`` the decoded error message
    from the API when it sent one.
    """

    def __init__(self, message: str, status_code: int, body: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class KeenableAuthError(KeenableAPIError):
    """The API key was rejected (HTTP 401/403)."""


class KeenableRateLimitError(KeenableAPIError):
    """The rate limit was exceeded (HTTP 429).

    Keyless requests share a lower hourly cap. Setting ``KEENABLE_API_KEY``
    lifts it; a key is never required to make a request.
    """


class KeenableInvalidRequestError(KeenableError):
    """The arguments passed to the SDK are invalid; no request was sent."""
