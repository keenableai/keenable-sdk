"""Exceptions raised by the Keenable SDK.

Every exception subclasses :class:`KeenableError`. Errors from the API itself
subclass :class:`KeenableAPIError` and are picked by HTTP status:

====  ==============================  ==========================================
400   :class:`KeenableValidationError`  A parameter was rejected (also 422)
401   :class:`KeenableAuthError`        The API key is missing or invalid
402   :class:`KeenableCreditsError`     The account is out of credits
403   :class:`KeenableForbiddenError`   The key or tier may not do this
429   :class:`KeenableRateLimitError`   The rate limit was exceeded
====  ==============================  ==========================================

:class:`KeenableInvalidRequestError` is different: it means the SDK rejected the
arguments itself and no request was sent.
"""

from __future__ import annotations

from typing import Any


class KeenableError(Exception):
    """Base class for every error raised by this SDK."""


class KeenableConnectionError(KeenableError):
    """The Keenable API could not be reached (DNS, TLS, timeout, ...).

    Search and fetch have no side effects, so retrying is safe.
    """


class KeenableAPIError(KeenableError):
    """The Keenable API returned a non-2xx response.

    Attributes:
        status_code: The HTTP status.
        body: The API's human-readable error message, when it sent one.
        api_error: The API's short error label, e.g. ``"Invalid parameter"``.
        details: Any structured ``details`` the API attached, unmodified.
        request_id: The ``X-Request-Id`` of the failed request. Quote it when
            you contact support.
        hint: The one-line next step that ends the message, e.g. what to fix
            or when to retry. Exposed separately so a harness can drop it
            before showing the error to a model.
    """

    def __init__(
        self,
        message: str,
        status_code: int,
        body: str | None = None,
        *,
        api_error: str | None = None,
        details: Any = None,
        request_id: str | None = None,
        hint: str | None = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.api_error = api_error
        self.details = details
        self.request_id = request_id
        self.hint = hint


class KeenableValidationError(KeenableAPIError):
    """The API rejected the request (HTTP 400 or 422).

    ``body`` says what was rejected, usually naming the parameter. Retrying
    unchanged fails the same way.
    """


class KeenableAuthError(KeenableAPIError):
    """The API key is missing or was rejected (HTTP 401).

    :class:`KeenableForbiddenError` (403) subclasses this, so existing
    ``except KeenableAuthError`` handlers keep catching both.
    """


class KeenableForbiddenError(KeenableAuthError):
    """The request is not allowed for this caller (HTTP 403).

    Typically a mode or feature that needs an API key, or a plan that
    includes it, e.g. ``mode="webql"`` without a key.
    """


class KeenableCreditsError(KeenableAPIError):
    """The account has no credits left (HTTP 402). Retrying will not help
    until credits are added."""


class KeenableRateLimitError(KeenableAPIError):
    """The rate limit was exceeded (HTTP 429).

    Keyless requests share a lower hourly cap. Setting ``KEENABLE_API_KEY``
    lifts it; a key is never required to make a request.

    Attributes:
        limit: ``X-RateLimit-Limit``, when sent.
        remaining: ``X-RateLimit-Remaining``, when sent.
        reset: ``X-RateLimit-Reset``, an ISO-8601 timestamp of when the window
            reopens, when sent.
    """

    def __init__(
        self,
        message: str,
        status_code: int,
        body: str | None = None,
        *,
        limit: int | None = None,
        remaining: int | None = None,
        reset: str | None = None,
        **kwargs: Any,
    ):
        super().__init__(message, status_code, body, **kwargs)
        self.limit = limit
        self.remaining = remaining
        self.reset = reset


class KeenableInvalidRequestError(KeenableError):
    """The arguments passed to the SDK are invalid; no request was sent."""
