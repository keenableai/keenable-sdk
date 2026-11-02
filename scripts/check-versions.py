#!/usr/bin/env python3
"""Fail when the SDKs' version numbers disagree.

The Python, TypeScript and Go SDKs ship one feature surface and release in
lockstep under one version number (see PUBLISH.md). Each version lives in its
own file, so a bump that misses one is easy; CI runs this to catch it.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def grab(path: str, pattern: str) -> str:
    text = (ROOT / path).read_text(encoding="utf-8")
    match = re.search(pattern, text, re.MULTILINE)
    if not match:
        sys.exit(f"check-versions: no version found in {path}")
    return match.group(1)


versions = {
    "python/pyproject.toml": grab("python/pyproject.toml", r'^version = "([^"]+)"'),
    "python/keenable/_version.py": grab(
        "python/keenable/_version.py", r'^__version__ = "([^"]+)"'
    ),
    "typescript/package.json": json.loads(
        (ROOT / "typescript/package.json").read_text(encoding="utf-8")
    )["version"],
    "go/version.go": grab("go/version.go", r'^const Version = "([^"]+)"'),
}

if len(set(versions.values())) != 1:
    width = max(map(len, versions))
    lines = "\n".join(f"  {path:<{width}}  {v}" for path, v in versions.items())
    sys.exit(
        "check-versions: the SDK versions disagree. Bump all of them together:\n"
        + lines
    )
print(f"check-versions: all SDKs at {next(iter(versions.values()))}")
