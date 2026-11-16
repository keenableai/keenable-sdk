"""The anonymous client ID a keyless client keeps.

The API issues an opaque token to a keyless caller in the ``X-Keenable-Client``
response header, and the client sends it back on later keyless requests, so
keyless traffic is told apart by an ID the server issued rather than by
address. It identifies an installation, not a person, is not a credential and
grants nothing. It is kept in ``<config dir>/keenable/client-id``, the file the
Keenable MCP bridge uses too, so one machine keeps one ID.

The rules (which values are a token, where the file lives) are the same in the
TypeScript and Go SDKs: see scripts/conformance/README.md.
"""

from __future__ import annotations

import contextlib
import os
import re
import sys
import tempfile
import threading
from collections.abc import Mapping

HEADER = "X-Keenable-Client"
# Set to any non-empty value, this turns the ID off: never read, written, sent
# or captured.
OPT_OUT_ENV = "KEENABLE_NO_CLIENT_ID"

_TOKEN = re.compile(r"[A-Za-z0-9._-]{1,128}")
_WINDOWS_DRIVE = re.compile(r"[A-Za-z]:[\\/]")


def valid_token(value: object) -> str | None:
    """``value`` when it is a token, else None. The token is never parsed."""
    if isinstance(value, str) and _TOKEN.fullmatch(value):
        return value
    return None


def _is_absolute(path: str, windows: bool) -> bool:
    if not windows:
        return path.startswith("/")
    return path[:1] in ("\\", "/") or _WINDOWS_DRIVE.match(path) is not None


def client_id_path(env: Mapping[str, str], windows: bool, home: str) -> str | None:
    """The client-id file, or None when there is no directory to keep it in.

    ``$XDG_CONFIG_HOME`` when it is set and absolute; else ``%APPDATA%`` on
    Windows, falling back to ``~/AppData/Roaming``; else ``~/.config``.
    """
    sep = "\\" if windows else "/"
    seps = "\\/" if windows else "/"
    xdg = env.get("XDG_CONFIG_HOME") or ""
    appdata = env.get("APPDATA") or ""
    if _is_absolute(xdg, windows):
        base = xdg
    elif windows and appdata:
        base = appdata
    elif not home:
        return None
    else:
        tail = ["AppData", "Roaming"] if windows else [".config"]
        base = sep.join([home.rstrip(seps), *tail])
    return sep.join([base.rstrip(seps), "keenable", "client-id"])


def _default_path() -> str | None:
    home = os.path.expanduser("~")
    return client_id_path(
        os.environ, sys.platform == "win32", "" if home == "~" else home
    )


class ClientIdStore:
    """One client's ID: loaded from the file once, then held in memory.

    Safe to share between threads. No filesystem failure is raised or logged:
    the ID then lives in memory for the client's lifetime.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loaded = False
        self._path: str | None = None
        self._token: str | None = None

    def get(self) -> str | None:
        """The ID to send, reading the file before the first request."""
        with self._lock:
            self._load()
            return self._token

    def capture(self, value: str | None) -> None:
        """Keep the ID a response carried; anything that is not a token is ignored."""
        token = valid_token(value)
        if token is None:
            return
        with self._lock:
            self._load()
            if token == self._token:
                return
            self._token = token
            self._write(token)

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            self._path = _default_path()
            if self._path is not None:
                with open(self._path, encoding="utf-8") as file:
                    # A token is at most 128 characters; a larger file is not one.
                    self._token = valid_token(file.read(1024).strip())
        except Exception:
            pass

    def _write(self, token: str) -> None:
        if self._path is None:
            return
        temp: str | None = None
        try:
            directory = os.path.dirname(self._path)
            os.makedirs(directory, mode=0o700, exist_ok=True)
            # mkstemp creates the file readable and writable by its owner only.
            handle, temp = tempfile.mkstemp(dir=directory, prefix="client-id.")
            with os.fdopen(handle, "w", encoding="utf-8") as file:
                file.write(token + "\n")
            os.replace(temp, self._path)
        except Exception:
            if temp is not None:
                with contextlib.suppress(OSError):
                    os.unlink(temp)
