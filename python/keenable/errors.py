"""Exceptions raised by the Keenable SDK."""

from __future__ import annotations

from dataclasses import dataclass


class KeenableError(Exception):
    """Base class for every error raised by this SDK."""


class KeenableConnectionError(KeenableError):
    """The Keenable API could not be reached (DNS, TLS, timeout, ...)."""


class KeenableTimeoutError(KeenableConnectionError):
    """The Keenable API did not answer within the deadline (``timeout``).

    A :class:`KeenableConnectionError`, so code that catches that keeps working.
    """


@dataclass(frozen=True)
class RateLimitInfo:
    """The limit a 429 hit, from the API's ``limit`` object.

    ``scope`` is who the limit counts (``"organization"``, ``"ip"``,
    ``"payer"`` or ``"agent"``), ``window`` its length (``"second"`` or
    ``"hour"``), ``max`` the requests allowed per window and ``resets_at`` an
    ISO 8601 time when the window opens again. A field the API left out is
    ``None``.
    """

    scope: str | None = None
    window: str | None = None
    max: int | None = None
    resets_at: str | None = None


class KeenableAPIError(KeenableError):
    """The Keenable API returned a non-2xx response.

    ``status_code`` is the HTTP status and ``body`` the decoded error message
    from the API when it sent one.

    The API's error body adds fields an agent can act on. Each is ``None``
    when the API did not send it, which is the case for older responses:

    - ``code``: a stable, machine-readable reason such as
      ``"rate_limit_per_second"`` or ``"target_blocked"``. Branch on this, not
      on the message.
    - ``type``: the error's category, one of ``"invalid_request_error"``,
      ``"authentication_error"``, ``"permission_error"``, ``"billing_error"``,
      ``"rate_limit_error"``, ``"target_error"`` (the page being fetched
      failed, not Keenable) or ``"api_error"``. Derived from the status and
      ``code`` when the API did not send it, so it is set on every response
      error.
    - ``error``: the API's short error title, e.g. ``"Rate limit exceeded"``.
    - ``fix``: one sentence on what to do next.
    - ``retryable``: whether sending the same request again can succeed.
    - ``retry_after_seconds``: how long to wait before retrying, from the
      body's ``retry_after_seconds`` or else the ``Retry-After`` header.
    - ``request_id``: quote it when reporting a problem.
    - ``param``: the request parameter a 400 is about.
    - ``limit``: a :class:`RateLimitInfo` on 429s.
    - ``value`` and ``reason``: the entry a 400 ``invalid_filter`` error
      rejected, such as one ``exclude_domains`` host; ``param`` names its
      parameter.

    ``str(err)`` ends with ``(code: <code>)`` and ``(request_id: <id>)`` when
    the API sent them.
    """

    def __init__(
        self,
        message: str,
        status_code: int,
        body: str | None = None,
        *,
        code: str | None = None,
        type: str | None = None,
        error: str | None = None,
        fix: str | None = None,
        retryable: bool | None = None,
        retry_after_seconds: float | None = None,
        request_id: str | None = None,
        param: str | None = None,
        limit: RateLimitInfo | None = None,
        value: str | None = None,
        reason: str | None = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.code = code
        self.type = type
        self.error = error
        self.fix = fix
        self.retryable = retryable
        self.retry_after_seconds = retry_after_seconds
        self.request_id = request_id
        self.param = param
        self.limit = limit
        self.value = value
        self.reason = reason


class KeenableAuthError(KeenableAPIError):
    """The API key was rejected (HTTP 401/403)."""


class KeenableRateLimitError(KeenableAPIError):
    """The rate limit was exceeded (HTTP 429).

    Keyless requests share a lower hourly cap. Setting ``KEENABLE_API_KEY``
    lifts it; a key is never required to make a request. Wait
    ``retry_after_seconds`` before retrying; ``limit`` says which limit was hit.
    """


class KeenableInsufficientCreditsError(KeenableAPIError):
    """The organization has no credits left (HTTP 402).

    Retrying returns the same error until credits are added. Also raised for
    a pay-per-request (x402) 402, which this SDK cannot pay: call the API with
    a key instead. The SDK does not expose billing links or payment offers.
    """


KeenableCreditsError = KeenableInsufficientCreditsError
"""Alias of :class:`KeenableInsufficientCreditsError`, the name the docs use."""


class KeenableInvalidRequestError(KeenableError):
    """The arguments passed to the SDK are invalid; no request was sent."""
