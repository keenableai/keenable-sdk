# Publishing

Three SDKs ship from this repo, on independent version numbers.

## Python (`keenable` on PyPI)

Trusted Publishing (OIDC), no tokens stored.

One-time setup on PyPI: register a Trusted Publisher for project `keenable`
pointing at repo `keenableai/keenable-sdk`, workflow `publish-python.yml`,
environment `pypi`.

To release:

1. Bump `version` in `python/pyproject.toml` and `__version__` in
   `python/keenable/_version.py` (the only two places it appears; `__init__`
   and the User-Agent both read the latter).
2. Create a GitHub Release tagged `python-v<version>` (e.g. `python-v0.1.1`).
3. `publish-python.yml` builds with `uv` and publishes. The workflow ignores
   releases whose tag does not start with `python-v`.

## TypeScript (`keenable` on npm)

Manual publish with OTP, matching how our other npm packages ship.

1. Bump `version` in `typescript/package.json`. Nothing else: the build injects
   it into the User-Agent, so there is no second copy to forget.
2. Build and verify:
   ```bash
   cd typescript
   npm install --legacy-peer-deps   # npm 10 crashes on vitest 4's peer set without it
   npm run typecheck && npm test && npm run build
   npm pack --dry-run    # check the file list
   ```
3. Publish:
   ```bash
   npm publish --access public --otp=<code>
   ```
4. Tag the release `ts-v<version>` on GitHub.

## Go (`github.com/keenableai/keenable-sdk/go`)

The module lives in `go/`. There is no registry workflow: `go get` and
pkg.go.dev follow a git tag.

1. Bump `Version` in `go/version.go`. That constant is the only copy. The
   User-Agent reads it.
2. Tag `go/v<version>` (for example `go/v0.1.0`) on the commit that contains
   that constant. The tag prefix is the module directory. Users install with
   `go get github.com/keenableai/keenable-sdk/go@v0.1.0`. The `@` version does
   not repeat the `go/` prefix.
3. The module proxy indexes the tag the first time someone fetches it.

A root `v0.1.0` tag does not version this module. `python-v*` and `ts-v*` do
not publish it either.

## Version sync

The three SDKs keep the same feature surface but version independently. When a
change touches more than one, release each and note it in the same GitHub
Release description.
