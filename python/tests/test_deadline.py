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


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:
        pass

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path.startswith("/trickle"):
            self._trickle()
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
                time.sleep(0.05)
        except OSError:
            pass


@pytest.fixture
def server() -> Iterator[str]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.daemon_threads = True
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
    """Each read finishes well inside 0.4 s, so httpx alone never times out."""
    client = Keenable(
        "k", base_url=f"{server}/trickle", timeout=httpx.Timeout(0.4), max_retries=0
    )
    started = time.monotonic()
    with pytest.raises(KeenableConnectionError) as caught:
        client.search("q")
    assert not isinstance(caught.value, KeenableTimeoutError)
    assert time.monotonic() - started > 2


@pytest.mark.parametrize("path", ["/plain", "/gzip"])
def test_sync_bodies_are_still_decoded(server: str, path: str) -> None:
    client = Keenable("k", base_url=f"{server}{path}", timeout=5)
    assert client.search("q").results == []


@pytest.mark.parametrize("path", ["/plain", "/gzip"])
async def test_async_bodies_are_still_decoded(server: str, path: str) -> None:
    client = AsyncKeenable("k", base_url=f"{server}{path}", timeout=5)
    assert (await client.search("q")).results == []
