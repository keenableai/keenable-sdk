"""Shared fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolated_config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point every test's config directory at a temporary one.

    A keyless client reads and writes ``<config dir>/keenable/client-id``;
    without this a test would use the real home directory.
    """
    config = tmp_path / "xdg-config"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config))
    monkeypatch.delenv("KEENABLE_NO_CLIENT_ID", raising=False)
    return config
