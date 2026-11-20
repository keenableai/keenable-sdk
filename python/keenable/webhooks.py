"""Verify the webhooks Keenable Monitors send.

Every delivery is signed as a Standard Webhook: ``webhook-id``,
``webhook-timestamp`` and ``webhook-signature`` headers, the signature an
HMAC-SHA256 of ``"<id>.<timestamp>.<body>"`` keyed by the monitor's
``webhook.secret``. Verify the raw body, before any JSON parsing:

    from keenable import verify_webhook, WebhookVerificationError

    @app.post("/keenable")
    async def keenable_hook(request: Request):
        try:
            event = verify_webhook(await request.body(), request.headers, SECRET)
        except WebhookVerificationError:
            return Response(status_code=400)
        if event.type == "monitor.result.found":
            print(event.data.result.url)
        elif event.type == "monitor.page.changed":
            print(event.data.run.changes.summary)
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import math
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .errors import WebhookVerificationError
from .monitors import Monitor, MonitorResult, MonitorRun

__all__ = [
    "DEFAULT_WEBHOOK_TOLERANCE",
    "WebhookEvent",
    "WebhookEventData",
    "verify_webhook",
]

DEFAULT_WEBHOOK_TOLERANCE = 300.0
"""How far, in seconds, a delivery's timestamp may be from now."""

_SECRET_PREFIX = "whsec_"


@dataclass
class WebhookEventData:
    """What an event is about. Which field is set depends on ``type``."""

    monitor_id: str
    monitor: Monitor | None = None
    """Set on ``monitor.created``, ``updated``, ``deleted`` and ``disabled``."""
    run: MonitorRun | None = None
    """Set on ``monitor.run.created``, ``completed`` and ``failed``, and on
    ``monitor.page.changed`` from a page monitor (its run, with its
    ``changes``)."""
    result: MonitorResult | None = None
    """Set on ``monitor.result.found`` and ``monitor.result.changed``."""
    reason: str | None = None
    """Why, on ``monitor.disabled``."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass
class WebhookEvent:
    """A verified webhook event."""

    id: str
    """The delivery's id, the same across retries: use it to drop repeats."""
    type: str
    created_at: str
    data: WebhookEventData
    metadata: dict[str, str] | None = None
    """The monitor's metadata."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> WebhookEvent:
        inner = data.get("data") if isinstance(data.get("data"), dict) else {}
        assert isinstance(inner, dict)
        monitor = inner.get("monitor")
        run = inner.get("run")
        result = inner.get("result")
        metadata = data.get("metadata")
        return cls(
            id=_text(data.get("id")),
            type=_text(data.get("type")),
            created_at=_text(data.get("created_at")),
            data=WebhookEventData(
                monitor_id=_text(inner.get("monitor_id")),
                monitor=Monitor._from_json(monitor)
                if isinstance(monitor, dict)
                else None,
                run=MonitorRun._from_json(run) if isinstance(run, dict) else None,
                result=MonitorResult._from_json(result)
                if isinstance(result, dict)
                else None,
                reason=_optional(inner.get("reason")),
                raw=inner,
            ),
            metadata={k: v for k, v in metadata.items() if isinstance(v, str)}
            if isinstance(metadata, dict)
            else None,
            raw=data,
        )


_MAX_STAMP_DIGITS = 12


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _optional(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _header(headers: Any, name: str) -> str | None:
    getter = getattr(headers, "get", None)
    if getter is not None:
        value = getter(name)
        if isinstance(value, str):
            return value
    if isinstance(headers, Mapping):
        for key, value in headers.items():
            if isinstance(key, str) and key.lower() == name and isinstance(value, str):
                return value
    return None


def _key(secret: str) -> bytes:
    text = secret
    if text.startswith(_SECRET_PREFIX):
        text = text[len(_SECRET_PREFIX) :]
    try:
        key = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        key = text.encode()
    if not key:
        raise WebhookVerificationError(
            "the webhook secret has no key after whsec_: "
            "pass the monitor's webhook.secret"
        )
    return key


def verify_webhook(
    payload: bytes | bytearray | str,
    headers: Mapping[str, str] | Any,
    secret: str,
    *,
    tolerance: float = DEFAULT_WEBHOOK_TOLERANCE,
    now: float | None = None,
) -> WebhookEvent:
    """Check a webhook delivery's signature and return the event it carries.

    Args:
        payload: The request body exactly as received, before any JSON
            parsing: re-encoding changes the bytes and breaks the signature.
        headers: The request headers, any mapping; names in any case.
        secret: The monitor's ``webhook.secret`` (``whsec_...``).
        tolerance: How far, in seconds, the delivery's timestamp may be from
            now (default 300). Older deliveries are refused, so a captured
            request cannot be replayed later.
        now: The current Unix time; tests pin it. Defaults to the clock.

    Raises:
        WebhookVerificationError: the delivery is not authentic or not fresh.
    """
    if not isinstance(secret, str) or not secret.strip():
        raise WebhookVerificationError(
            "the webhook secret is empty: pass the monitor's webhook.secret"
        )
    if (
        isinstance(tolerance, bool)
        or not isinstance(tolerance, (int, float))
        or not tolerance > 0
        or (isinstance(tolerance, float) and not math.isfinite(tolerance))
    ):
        raise WebhookVerificationError(
            "tolerance must be a positive, finite number of seconds"
        )
    body = payload.encode() if isinstance(payload, str) else bytes(payload)
    msg_id = _header(headers, "webhook-id")
    stamp = _header(headers, "webhook-timestamp")
    signatures = _header(headers, "webhook-signature")
    if not msg_id or not stamp or not signatures:
        raise WebhookVerificationError(
            "missing webhook-id, webhook-timestamp or webhook-signature header"
        )
    stamp = stamp.strip()
    if not stamp.isascii() or not stamp.isdigit() or len(stamp) > _MAX_STAMP_DIGITS:
        raise WebhookVerificationError(
            f"webhook-timestamp is not a Unix time: {stamp!r}"
        )
    clock = time.time() if now is None else now
    if not math.isfinite(clock) or abs(clock - int(stamp)) > tolerance:
        raise WebhookVerificationError(
            "webhook-timestamp is too far from now: the delivery is stale "
            "or the clock is off"
        )
    mac = hmac.new(
        _key(secret),
        msg_id.encode() + b"." + stamp.encode() + b"." + body,
        hashlib.sha256,
    )
    expected = base64.b64encode(mac.digest())
    matched = False
    for candidate in signatures.split():
        version, _, sig = candidate.partition(",")
        if version == "v1" and hmac.compare_digest(sig.encode(), expected):
            matched = True
    if not matched:
        raise WebhookVerificationError(
            "no webhook-signature matches: check the secret and verify the raw body"
        )
    try:
        event = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise WebhookVerificationError("the signed body is not JSON") from exc
    if not isinstance(event, dict):
        raise WebhookVerificationError("the signed body is not a JSON object")
    return WebhookEvent._from_json(event)
