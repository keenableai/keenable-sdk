"""The anonymous client ID of a keyless client.

Every test's config directory is a temporary one (tests/conftest.py).
"""

from __future__ import annotations

import contextlib
import os
import stat
import sys
import threading
from pathlib import Path
from typing import Any

import httpx
import pytest

from keenable import AsyncKeenable, Keenable, KeenableRateLimitError
from keenable import _client_id as client_id_module
from keenable import client as client_module

TOKEN = "kc1.AbC-dEf_123.s1x2y3.q9"
OTHER = "kc1.other-token"
HEADER = "X-Keenable-Client"
CLIENTS = ["sync", "async"]


class Server:
    """Answers every request, issuing ``issue`` as the ID, and records them."""

    def __init__(self, issue: str | None = None, status: int = 200) -> None:
        self.issue = issue
        self.status = status
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        headers = {} if self.issue is None else {HEADER: self.issue.encode("utf-8")}
        body: dict[str, Any] = (
            {"results": [], "content": "c"} if self.status == 200 else {"error": "e"}
        )
        return httpx.Response(self.status, headers=headers, json=body)

    @property
    def sent(self) -> list[str | None]:
        """The client ID each request carried."""
        return [request.headers.get(HEADER) for request in self.requests]


async def search(kind: str, server: Server, times: int = 1, **options: Any) -> None:
    """Search ``times`` on one client of ``kind``; API errors are swallowed."""
    transport = httpx.MockTransport(server)
    options.setdefault("max_retries", 0)
    if kind == "sync":
        with Keenable(client=httpx.Client(transport=transport), **options) as c:
            for _ in range(times):
                with contextlib.suppress(KeenableRateLimitError):
                    c.search("q")
    else:
        async with AsyncKeenable(
            client=httpx.AsyncClient(transport=transport), **options
        ) as ac:
            for _ in range(times):
                with contextlib.suppress(KeenableRateLimitError):
                    await ac.search("q")


def id_file(config: Path) -> Path:
    return config / "keenable" / "client-id"


def store(config: Path, token: str) -> None:
    id_file(config).parent.mkdir(parents=True)
    id_file(config).write_text(token + "\n", "utf-8")


@pytest.mark.parametrize("kind", CLIENTS)
async def test_an_issued_id_is_sent_next_and_written(
    kind: str, isolated_config_dir: Path
) -> None:
    server = Server(issue=TOKEN)
    await search(kind, server, times=3)
    assert server.sent == [None, TOKEN, TOKEN]
    assert "/public" in str(server.requests[0].url)
    path = id_file(isolated_config_dir)
    assert path.read_text("utf-8") == TOKEN + "\n"
    assert [p.name for p in path.parent.iterdir()] == ["client-id"]
    if sys.platform != "win32":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700


@pytest.mark.parametrize("kind", CLIENTS)
async def test_fetch_uses_the_id_too(kind: str, isolated_config_dir: Path) -> None:
    server = Server(issue=TOKEN)
    transport = httpx.MockTransport(server)
    if kind == "sync":
        with Keenable(client=httpx.Client(transport=transport)) as c:
            c.fetch("https://example.com/")
            c.fetch("https://example.com/")
    else:
        async with AsyncKeenable(client=httpx.AsyncClient(transport=transport)) as ac:
            await ac.fetch("https://example.com/")
            await ac.fetch("https://example.com/")
    assert server.sent == [None, TOKEN]


@pytest.mark.parametrize("kind", CLIENTS)
async def test_an_error_response_issues_an_id_and_the_retry_carries_it(
    kind: str, isolated_config_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_module.time, "sleep", lambda _delay: None)

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(client_module.asyncio, "sleep", no_sleep)
    server = Server(issue=TOKEN, status=429)
    await search(kind, server, max_retries=1)
    assert server.sent == [None, TOKEN]
    assert id_file(isolated_config_dir).read_text("utf-8") == TOKEN + "\n"


@pytest.mark.parametrize("kind", CLIENTS)
async def test_a_stored_id_is_sent_on_the_first_request(
    kind: str, isolated_config_dir: Path
) -> None:
    store(isolated_config_dir, f"  {TOKEN}  ")
    before = id_file(isolated_config_dir).stat().st_mtime_ns
    server = Server()
    await search(kind, server, times=2)
    assert server.sent == [TOKEN, TOKEN]
    # Nothing changed, so nothing was written.
    assert id_file(isolated_config_dir).stat().st_mtime_ns == before
    assert id_file(isolated_config_dir).read_text("utf-8") == f"  {TOKEN}  \n"


@pytest.mark.parametrize("kind", CLIENTS)
async def test_a_new_id_replaces_the_stored_one(
    kind: str, isolated_config_dir: Path
) -> None:
    store(isolated_config_dir, TOKEN)
    server = Server(issue=OTHER)
    await search(kind, server, times=2)
    assert server.sent == [TOKEN, OTHER]
    assert id_file(isolated_config_dir).read_text("utf-8") == OTHER + "\n"


@pytest.mark.parametrize("kind", CLIENTS)
async def test_the_same_id_again_is_not_rewritten(
    kind: str, isolated_config_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store(isolated_config_dir, TOKEN)
    writes: list[str] = []
    monkeypatch.setattr(
        client_id_module.ClientIdStore,
        "_write",
        lambda self, token: writes.append(token),
    )
    await search(kind, Server(issue=TOKEN), times=2)
    assert writes == []


@pytest.mark.parametrize("kind", CLIENTS)
@pytest.mark.parametrize("stored", ["", "not a token", "a/b", "a" * 129, "one\ntwo"])
async def test_an_invalid_file_is_no_id(
    kind: str, stored: str, isolated_config_dir: Path
) -> None:
    store(isolated_config_dir, stored)
    server = Server()
    await search(kind, server)
    assert server.sent == [None]


@pytest.mark.parametrize("kind", CLIENTS)
async def test_a_client_with_a_key_never_uses_the_id(
    kind: str, isolated_config_dir: Path
) -> None:
    store(isolated_config_dir, TOKEN)
    server = Server(issue=OTHER)
    await search(kind, server, times=2, api_key="k")
    assert server.sent == [None, None]
    assert "/public" not in str(server.requests[0].url)
    assert id_file(isolated_config_dir).read_text("utf-8") == TOKEN + "\n"


@pytest.mark.parametrize("kind", CLIENTS)
async def test_a_key_from_the_environment_counts(
    kind: str, isolated_config_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KEENABLE_API_KEY", "k")
    server = Server(issue=TOKEN)
    await search(kind, server, times=2)
    assert server.sent == [None, None]
    assert not id_file(isolated_config_dir).exists()


@pytest.mark.parametrize("kind", CLIENTS)
@pytest.mark.parametrize("how", ["option", "env"])
async def test_opting_out_reads_sends_captures_and_writes_nothing(
    kind: str, how: str, isolated_config_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store(isolated_config_dir, TOKEN)
    options: dict[str, Any] = {}
    if how == "option":
        options["anonymous_client_id"] = False
    else:
        monkeypatch.setenv("KEENABLE_NO_CLIENT_ID", "1")
    opened: list[str] = []
    real_open = open

    def spy(path: Any, *args: Any, **kwargs: Any) -> Any:
        opened.append(str(path))
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr("builtins.open", spy)
    server = Server(issue=OTHER)
    await search(kind, server, times=2, **options)
    monkeypatch.undo()
    assert server.sent == [None, None]
    assert not [path for path in opened if path.endswith("client-id")]
    assert id_file(isolated_config_dir).read_text("utf-8") == TOKEN + "\n"


async def test_an_empty_opt_out_variable_is_not_an_opt_out(
    isolated_config_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KEENABLE_NO_CLIENT_ID", "")
    server = Server(issue=TOKEN)
    await search("sync", server, times=2)
    assert server.sent == [None, TOKEN]


@pytest.mark.parametrize("kind", CLIENTS)
@pytest.mark.parametrize(
    "value", ["", "has space", "a/b", "a" * 129, "kc1.a, kc1.b", "café"]
)
async def test_a_malformed_header_is_ignored(
    kind: str, value: str, isolated_config_dir: Path
) -> None:
    server = Server(issue=value)
    await search(kind, server, times=2)
    assert server.sent == [None, None]
    assert not id_file(isolated_config_dir).exists()


@pytest.mark.parametrize("kind", CLIENTS)
async def test_a_malformed_header_keeps_the_stored_id(
    kind: str, isolated_config_dir: Path
) -> None:
    store(isolated_config_dir, TOKEN)
    server = Server(issue="not a token")
    await search(kind, server, times=2)
    assert server.sent == [TOKEN, TOKEN]
    assert id_file(isolated_config_dir).read_text("utf-8") == TOKEN + "\n"


@pytest.mark.parametrize("kind", CLIENTS)
async def test_a_server_that_never_sends_the_header_changes_nothing(
    kind: str, isolated_config_dir: Path
) -> None:
    server = Server()
    await search(kind, server, times=2)
    assert server.sent == [None, None]
    assert not isolated_config_dir.exists()


@pytest.mark.parametrize("kind", CLIENTS)
async def test_an_unwritable_config_dir_keeps_the_id_in_memory(
    kind: str, isolated_config_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A file where the directory should be: nothing under it can be created.
    blocker = isolated_config_dir.parent / "not-a-directory"
    blocker.write_text("", "utf-8")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(blocker))
    server = Server(issue=TOKEN)
    await search(kind, server, times=2)
    assert server.sent == [None, TOKEN]
    assert blocker.read_text("utf-8") == ""


@pytest.mark.parametrize("kind", CLIENTS)
async def test_a_failed_rename_leaves_no_temporary_file(
    kind: str, isolated_config_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_args: Any) -> None:
        raise PermissionError("read-only")

    monkeypatch.setattr(client_id_module.os, "replace", refuse)
    server = Server(issue=TOKEN)
    await search(kind, server, times=2)
    assert server.sent == [None, TOKEN]
    assert list(id_file(isolated_config_dir).parent.iterdir()) == []


@pytest.mark.parametrize("kind", CLIENTS)
async def test_a_client_id_file_that_is_a_directory_is_no_id(
    kind: str, isolated_config_dir: Path
) -> None:
    id_file(isolated_config_dir).mkdir(parents=True)
    server = Server(issue=TOKEN)
    await search(kind, server, times=2)
    assert server.sent == [None, TOKEN]
    assert id_file(isolated_config_dir).is_dir()


async def test_no_config_dir_at_all_keeps_the_id_in_memory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(client_id_module, "_default_path", lambda: None)
    server = Server(issue=TOKEN)
    await search("sync", server, times=2)
    assert server.sent == [None, TOKEN]


def test_the_default_path_follows_the_environment(
    isolated_config_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert client_id_module._default_path() == os.path.join(
        str(isolated_config_dir), "keenable", "client-id"
    )
    monkeypatch.delenv("XDG_CONFIG_HOME")
    monkeypatch.setattr(client_id_module.os.path, "expanduser", lambda _path: "~")
    monkeypatch.delenv("APPDATA", raising=False)
    assert client_id_module._default_path() is None


def test_the_file_is_read_once_per_client(
    isolated_config_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store(isolated_config_dir, TOKEN)
    server = Server()
    with Keenable(client=httpx.Client(transport=httpx.MockTransport(server))) as c:
        c.search("q")
        id_file(isolated_config_dir).write_text(OTHER + "\n", "utf-8")
        c.search("q")
    assert server.sent == [TOKEN, TOKEN]


def test_threads_share_one_id(isolated_config_dir: Path) -> None:
    server = Server(issue=TOKEN)
    with Keenable(client=httpx.Client(transport=httpx.MockTransport(server))) as c:
        threads = [threading.Thread(target=c.search, args=("q",)) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        c.search("q")
    assert server.sent[-1] == TOKEN
    assert set(server.sent) <= {None, TOKEN}
    assert id_file(isolated_config_dir).read_text("utf-8") == TOKEN + "\n"
    assert [p.name for p in id_file(isolated_config_dir).parent.iterdir()] == [
        "client-id"
    ]
