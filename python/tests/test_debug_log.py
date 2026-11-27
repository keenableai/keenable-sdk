"""Debug logging: one line per attempt on the ``keenable`` logger."""

from __future__ import annotations

import logging
import re
import subprocess
import sys
from collections.abc import Callable

import httpx
import pytest

from keenable import (
    AsyncKeenable,
    Keenable,
    KeenableAPIError,
    KeenableConnectionError,
    _debug,
)
from keenable import client as client_module

SECRET = "sk-secret-key-must-not-appear"
SECRET_HEADER = "header-secret-must-not-appear"
SECRET_QUERY = "query-text-must-not-appear"
Reply = Callable[[httpx.Request], httpx.Response]


@pytest.fixture
def waits(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    recorded: list[float] = []
    monkeypatch.setattr(client_module.time, "sleep", recorded.append)

    async def fake_sleep(delay: float) -> None:
        recorded.append(delay)

    monkeypatch.setattr(client_module.asyncio, "sleep", fake_sleep)
    monkeypatch.delenv("KEENABLE_API_URL", raising=False)
    return recorded


def busy(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        503, json={"message": "busy"}, headers={"X-Request-Id": "req-1"}
    )


def ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200, json={"query": "q", "results": []}, headers={"X-Request-Id": "req-2"}
    )


def handler_for(replies: list[Reply], seen: list[httpx.Request]) -> Reply:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return replies[min(len(seen) - 1, len(replies) - 1)](request)

    return handler


def sync_client(replies: list[Reply], seen: list[httpx.Request]) -> Keenable:
    return Keenable(
        api_key=SECRET,
        default_headers={"X-Proxy-Token": SECRET_HEADER},
        client=httpx.Client(transport=httpx.MockTransport(handler_for(replies, seen))),
    )


LINE = re.compile(
    r"method=POST path=/v1/search attempt=(\d) status=(\d+) elapsed_ms=\d+ "
    r"retry=(true|false)( wait_ms=\d+)? request_id=(req-\d)"
)


def test_one_line_per_attempt_and_never_the_key(
    waits: list[float], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="keenable")
    seen: list[httpx.Request] = []
    client = sync_client([busy, ok], seen)
    client.search(SECRET_QUERY)
    assert len(seen) == 2 and seen[0].headers["X-API-Key"] == SECRET
    messages = [r.getMessage() for r in caplog.records if r.name == "keenable"]
    assert len(messages) == 2
    first, second = (LINE.fullmatch(m) for m in messages)
    assert first and second, messages
    assert first.groups()[:3] == ("1", "503", "true")
    assert first.group(4) == f" wait_ms={int(waits[0] * 1000)}"
    assert first.group(5) == "req-1"
    assert second.groups() == ("2", "200", "false", None, "req-2")
    text = caplog.text + "\n".join(messages)
    for secret in (SECRET, SECRET_HEADER, SECRET_QUERY):
        assert secret not in text


async def test_async_client_logs_the_same(
    waits: list[float], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="keenable")
    seen: list[httpx.Request] = []
    client = AsyncKeenable(
        api_key=SECRET,
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler_for([busy, ok], seen))
        ),
    )
    await client.search(SECRET_QUERY)
    messages = [r.getMessage() for r in caplog.records if r.name == "keenable"]
    assert [bool(LINE.fullmatch(m)) for m in messages] == [True, True]
    assert SECRET not in caplog.text and SECRET_QUERY not in caplog.text


def test_a_failure_that_is_not_retried(
    waits: list[float], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="keenable")
    client = Keenable(
        api_key=SECRET,
        max_retries=0,
        client=httpx.Client(transport=httpx.MockTransport(busy)),
    )
    with pytest.raises(KeenableAPIError):
        client.search("q")
    (message,) = [r.getMessage() for r in caplog.records if r.name == "keenable"]
    assert re.fullmatch(
        r"method=POST path=/v1/search attempt=1 status=503 elapsed_ms=\d+ "
        r"retry=false request_id=req-1",
        message,
    )


def test_a_connection_error_and_a_redirect(
    waits: list[float], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="keenable")

    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    def moved(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "https://elsewhere.example/"})

    for handler, error in ((refused, "connection"), (moved, "redirect")):
        caplog.clear()
        client = Keenable(
            api_key=SECRET,
            max_retries=0,
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(KeenableConnectionError):
            client.billing()
        (message,) = [r.getMessage() for r in caplog.records if r.name == "keenable"]
        assert re.fullmatch(
            rf"method=GET path=/v1/billing attempt=1 error={error} "
            r"elapsed_ms=\d+ retry=false",
            message,
        )


def test_nothing_is_logged_when_the_logger_is_off(
    waits: list[float], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="keenable")
    client = sync_client([ok], [])
    client.search("q")
    assert [r for r in caplog.records if r.name == "keenable"] == []


def test_keenable_log_debug_prints_to_stderr() -> None:
    """KEENABLE_LOG=debug alone attaches a stderr handler, without the key."""
    script = (
        "import httpx, keenable\n"
        "t = httpx.MockTransport(lambda r: httpx.Response(200, json={'results': []},"
        " headers={'X-Request-Id': 'req-9'}))\n"
        f"keenable.Keenable(api_key={SECRET!r}, client=httpx.Client(transport=t))"
        ".search('q')\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", script],
        env={"KEENABLE_LOG": "debug", "PATH": ""},
        capture_output=True,
        text=True,
        check=True,
    )
    assert done.stdout == ""
    assert re.fullmatch(
        r"keenable: method=POST path=/v1/search attempt=1 status=200 "
        r"elapsed_ms=\d+ retry=false request_id=req-9\n",
        done.stderr,
    ), done.stderr
    assert SECRET not in done.stderr


def test_without_keenable_log_nothing_is_printed() -> None:
    script = (
        "import httpx, keenable\n"
        "t = httpx.MockTransport(lambda r: httpx.Response(200, json={'results': []}))\n"
        "keenable.Keenable(client=httpx.Client(transport=t)).search('q')\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", script],
        env={"PATH": ""},
        capture_output=True,
        text=True,
        check=True,
    )
    assert done.stderr == ""


def test_the_env_handler_is_attached_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KEENABLE_LOG", "debug")
    monkeypatch.setattr(_debug, "_ENV_HANDLER", [])
    before = list(_debug.logger.handlers)
    level = _debug.logger.level
    try:
        Keenable()
        Keenable()
        added = [h for h in _debug.logger.handlers if h not in before]
        assert len(added) == 1
    finally:
        for handler in _debug.logger.handlers:
            if handler not in before:
                _debug.logger.removeHandler(handler)
        _debug.logger.setLevel(level)
