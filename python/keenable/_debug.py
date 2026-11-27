"""Opt-in debug logging: one line per attempt, on the ``keenable`` logger.

Each line has the method, the URL's path, the attempt number, the status (or
what failed), the elapsed time, the retry decision and wait, and the request
id. Never the API key, a header, the query string or a body. The format is the
same in every Keenable SDK: scripts/conformance/README.md.

``KEENABLE_LOG=debug`` attaches a stderr handler; otherwise configure the
``keenable`` logger as any other (``logging.getLogger("keenable")``).
"""

from __future__ import annotations

import logging
import sys
from os import environ

logger = logging.getLogger("keenable")

_ENV_HANDLER: list[logging.Handler] = []
"""The stderr handler KEENABLE_LOG attached, so it is attached only once."""

_MAX_REQUEST_ID = 128


def env_enabled(value: str | None) -> bool:
    """Whether a KEENABLE_LOG value turns debug logging on: ``debug``, any case."""
    return value is not None and value.strip().lower() == "debug"


def enable_from_env() -> None:
    """With KEENABLE_LOG=debug, send the ``keenable`` logger's debug lines to stderr."""
    if _ENV_HANDLER or not env_enabled(environ.get("KEENABLE_LOG")):
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    _ENV_HANDLER.append(handler)


def enabled() -> bool:
    """Whether the ``keenable`` logger takes debug lines."""
    return logger.isEnabledFor(logging.DEBUG)


def _loggable_id(request_id: str | None) -> str | None:
    if not request_id or len(request_id) > _MAX_REQUEST_ID:
        return None
    if not all("!" <= c <= "~" for c in request_id):
        return None
    return request_id


def attempt_fields(
    *,
    method: str,
    path: str,
    attempt: int,
    status: int | None,
    error: str | None,
    elapsed_ms: int,
    retry: bool,
    wait_ms: int | None,
    request_id: str | None,
) -> str:
    """One attempt's line, after the ``keenable: `` prefix."""
    parts = [f"method={method}", f"path={path}", f"attempt={attempt}"]
    parts.append(f"status={status}" if status is not None else f"error={error}")
    parts.append(f"elapsed_ms={elapsed_ms}")
    parts.append(f"retry={'true' if retry else 'false'}")
    if retry and wait_ms is not None:
        parts.append(f"wait_ms={wait_ms}")
    rid = _loggable_id(request_id)
    if rid is not None:
        parts.append(f"request_id={rid}")
    return " ".join(parts)


def log_attempt(
    *,
    method: str,
    path: str,
    attempt: int,
    status: int | None,
    error: str | None,
    elapsed: float,
    wait: float | None,
    request_id: str | None,
) -> None:
    """Log one attempt on the ``keenable`` logger, at debug level."""
    logger.debug(
        "%s",
        attempt_fields(
            method=method,
            path=path,
            attempt=attempt,
            status=status,
            error=error,
            elapsed_ms=int(elapsed * 1000),
            retry=wait is not None,
            wait_ms=int(wait * 1000) if wait is not None else None,
            request_id=request_id,
        ),
    )
