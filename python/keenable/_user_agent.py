"""The User-Agent the SDK sends.

``keenable-python/<sdk version> python/<python version> <os>/<arch>``, for
example ``keenable-python/0.4.0 python/3.12.4 linux/x86_64``. Nothing else is
sent: no host name, user, path, key or locale. A caller's ``User-Agent`` in
``default_headers`` or ``extra_headers`` replaces it. The formatting rule is
shared with the other SDKs (scripts/conformance/README.md, "User-Agent").
"""

from __future__ import annotations

import platform
import re
from collections.abc import Iterable

from ._version import __version__

_UNSAFE = re.compile(r"[^A-Za-z0-9._+-]+")
_MAX_LEN = 64


def _clean(text: str) -> str:
    return _UNSAFE.sub("-", text)[:_MAX_LEN].strip("-")


def format_user_agent(parts: Iterable[tuple[str, str]]) -> str:
    """``name/version`` per part, space-separated, each half cleaned.

    A part whose name cleans to nothing is left out; one whose version cleans
    to nothing is its name alone.
    """
    out = []
    for name, version in parts:
        name, version = _clean(name), _clean(version)
        if name:
            out.append(f"{name}/{version}" if version else name)
    return " ".join(out)


def _platform_part() -> tuple[str, str]:
    try:
        return platform.system().lower(), platform.machine().lower()
    except Exception:  # pragma: no cover - platform lookups do not fail in practice
        return "", ""


USER_AGENT = format_user_agent(
    [
        ("keenable-python", __version__),
        ("python", platform.python_version()),
        _platform_part(),
    ]
)
