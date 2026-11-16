"""A numeric timeout bounds the whole attempt, not only each httpx phase."""

from __future__ import annotations

import gzip
import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from keenable import (
    AsyncKeenable,
    Keenable,
    KeenableConnectionError,
    KeenableTimeoutError,
)

BODY = json.dumps({"query": "q", "results": []}).encode()


def _pause(seconds: float) -> None:
    """Sleep without time.sleep, which other tests patch for the whole process."""
    threading.Event().wait(seconds)


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:
        pass

    def handle(self) -> None:
        # One request per connection: a keep-alive wait for a second request
        # would hold the thread server_close() joins.
        self.close_connection = True
        self.handle_one_request()

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path.startswith("/trickle"):
            self._trickle()
        elif self.path.startswith("/headers"):
            self._trickled_headers()
        elif self.path.startswith("/terminator"):
            self._late_terminator()
        elif self.path.startswith("/gzip"):
            self._whole(gzip.compress(BODY), {"Content-Encoding": "gzip"})
        else:
            self._whole(BODY, {})

    def _whole(self, body: bytes, headers: dict[str, str]) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _trickle(self) -> None:
        """One byte every 50 ms: each read is quick, the body never ends in time."""
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "100000")
        self.end_headers()
        try:
            for _ in range(60):
                self.wfile.write(b" ")
                self.wfile.flush()
                _pause(0.05)
        except OSError:
            pass

    def _trickled_headers(self) -> None:
        """A header line one byte every 50 ms for 1 s: it never ends within 0.5 s."""
        try:
            self.wfile.write(b"HTTP/1.1 200 OK\r\nX-Slow: ")
            for _ in range(20):
                self.wfile.write(b"a")
                self.wfile.flush()
                _pause(0.05)
        except OSError:
            pass

    def _late_terminator(self) -> None:
        """The whole JSON body before the deadline, the chunked terminator after it.

        Each gap (0.3 s) is shorter than the 0.5 s timeout, so httpx's per-read
        timeout never fires: only the deadline on the whole attempt does.
        """
        try:
            self.wfile.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                b"Transfer-Encoding: chunked\r\n\r\n"
            )
            self.wfile.flush()
            _pause(0.3)
            self.wfile.write(f"{len(BODY):x}\r\n".encode() + BODY + b"\r\n")
            self.wfile.flush()
            _pause(0.3)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except OSError:
            pass


@pytest.fixture
def server() -> Iterator[str]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    # server_close() then waits for every reply to finish, so no thread of this
    # test is still running when the next one starts.
    httpd.daemon_threads = False
    httpd.block_on_close = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_sync_attempt_ends_at_the_deadline_mid_body(server: str) -> None:
    client = Keenable("k", base_url=f"{server}/trickle", timeout=0.5, max_retries=0)
    started = time.monotonic()
    with pytest.raises(KeenableTimeoutError, match="within 0.5 s"):
        client.search("q")
    assert 0.4 < time.monotonic() - started < 1.5


async def test_async_attempt_ends_at_the_deadline_mid_body(server: str) -> None:
    client = AsyncKeenable(
        "k", base_url=f"{server}/trickle", timeout=0.5, max_retries=0
    )
    started = time.monotonic()
    with pytest.raises(KeenableTimeoutError, match="within 0.5 s"):
        await client.search("q")
    assert 0.4 < time.monotonic() - started < 1.5


def test_per_call_timeout_is_the_deadline_too(server: str) -> None:
    client = Keenable("k", base_url=f"{server}/trickle", timeout=30, max_retries=0)
    started = time.monotonic()
    with pytest.raises(KeenableTimeoutError, match="within 0.3 s"):
        client.search("q", timeout=0.3)
    assert time.monotonic() - started < 1.3


def test_a_deadline_timeout_is_retried_like_any_timeout(server: str) -> None:
    client = Keenable("k", base_url=f"{server}/trickle", timeout=0.2, max_retries=1)
    started = time.monotonic()
    with pytest.raises(KeenableTimeoutError):
        client.search("q")
    # Two attempts of 0.2 s and one backoff of at most 0.5 s.
    assert 0.4 < time.monotonic() - started < 2.5


def test_an_httpx_timeout_object_keeps_per_phase_meaning(server: str) -> None:
    """Each trickled read finishes inside 0.4 s; only the stall after it times out."""
    client = Keenable(
        "k", base_url=f"{server}/trickle", timeout=httpx.Timeout(0.4), max_retries=0
    )
    started = time.monotonic()
    with pytest.raises(KeenableConnectionError):
        client.search("q")
    assert time.monotonic() - started > 2


@pytest.mark.parametrize("path", ["/plain", "/gzip"])
def test_sync_bodies_are_still_decoded(server: str, path: str) -> None:
    client = Keenable("k", base_url=f"{server}{path}", timeout=5)
    assert client.search("q").results == []


@pytest.mark.parametrize("path", ["/plain", "/gzip"])
async def test_async_bodies_are_still_decoded(server: str, path: str) -> None:
    client = AsyncKeenable("k", base_url=f"{server}{path}", timeout=5)
    assert (await client.search("q")).results == []


@pytest.mark.parametrize("path", ["/headers", "/terminator"])
def test_sync_deadline_covers_headers_and_the_end_of_the_body(
    server: str, path: str
) -> None:
    client = Keenable("k", base_url=f"{server}{path}", timeout=0.5, max_retries=0)
    started = time.monotonic()
    with pytest.raises(KeenableTimeoutError, match="within 0.5 s"):
        client.search("q")
    assert 0.45 < time.monotonic() - started < 0.9


@pytest.mark.parametrize("path", ["/headers", "/terminator"])
async def test_async_deadline_covers_headers_and_the_end_of_the_body(
    server: str, path: str
) -> None:
    client = AsyncKeenable("k", base_url=f"{server}{path}", timeout=0.5, max_retries=0)
    started = time.monotonic()
    with pytest.raises(KeenableTimeoutError, match="within 0.5 s"):
        await client.search("q")
    assert 0.45 < time.monotonic() - started < 0.9


class _RecordingClient(httpx.Client):
    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)  # type: ignore[arg-type]
        self.seen: list[str] = []

    def request(  # type: ignore[override]
        self, method: str, url: object, **kwargs: object
    ) -> httpx.Response:
        self.seen.append(method)
        headers = dict(kwargs.pop("headers", None) or {})  # type: ignore[call-overload]
        headers["X-Policy"] = "applied"
        return super().request(method, url, headers=headers, **kwargs)  # type: ignore[arg-type]


class _AsyncRecordingClient(httpx.AsyncClient):
    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)  # type: ignore[arg-type]
        self.seen: list[str] = []

    async def request(  # type: ignore[override]
        self, method: str, url: object, **kwargs: object
    ) -> httpx.Response:
        self.seen.append(method)
        headers = dict(kwargs.pop("headers", None) or {})  # type: ignore[call-overload]
        headers["X-Policy"] = "applied"
        return await super().request(method, url, headers=headers, **kwargs)  # type: ignore[arg-type]


def _answer_if_policy_applied(request: httpx.Request) -> httpx.Response:
    assert request.headers.get("X-Policy") == "applied"
    return httpx.Response(200, json={"query": "q", "results": []})


def test_sync_deadline_still_goes_through_a_clients_request_override() -> None:
    http = _RecordingClient(transport=httpx.MockTransport(_answer_if_policy_applied))
    client = Keenable("k", client=http, timeout=5, max_retries=0)
    assert client.search("q").results == []
    assert http.seen == ["POST"]


async def test_async_deadline_still_goes_through_a_clients_request_override() -> None:
    http = _AsyncRecordingClient(
        transport=httpx.MockTransport(_answer_if_policy_applied)
    )
    client = AsyncKeenable("k", client=http, timeout=5, max_retries=0)
    assert (await client.search("q")).results == []
    assert http.seen == ["POST"]


def test_sync_deadline_hands_back_the_requests_own_error() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    http = httpx.Client(transport=httpx.MockTransport(refuse))
    client = Keenable("k", client=http, timeout=5, max_retries=0)
    with pytest.raises(KeenableConnectionError, match="refused"):
        client.search("q")
