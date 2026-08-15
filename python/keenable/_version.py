"""The one place the package version is written.

`__init__` re-exports it as ``__version__`` and the client builds its
User-Agent from it, so a release bumps this file and ``pyproject.toml`` and
nothing else. Reading it from installed metadata instead would cost a
filesystem walk on every import for a value that never changes.
"""

__version__ = "0.1.1"
