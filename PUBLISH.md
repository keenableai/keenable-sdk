# Publishing

Three SDKs ship from this repo, on independent version numbers.

## Automated bump and tag

One command, from any machine with `gh` logged in and Node 22.18+:

```bash
node scripts/release.ts python patch       # or typescript, go; patch, minor, major or X.Y.Z
node scripts/release.ts all 0.1.5          # all three SDKs at one shared version, in one PR
```

It runs the **Cut SDK release** workflow (bumps that SDK's version files below and moves its changelog `Unreleased` entries under the new version, on a `release/<sdk>-vX.Y.Z` branch, and runs the tests), opens the PR as you, waits for the tests and the Qodo approval, squash-merges the commit the tests ran on, and waits for the publish. Merging tags and publishes the SDK: a GitHub Release plus `publish-python.yml` (PyPI) for Python, a GitHub Release plus `publish-typescript.yml` (npm, Trusted Publishing, no OTP) for TypeScript, a `go/v<version>` tag for Go. `all` takes the highest current version as the base for `patch`/`minor`/`major`, and every SDK must end up above its current version. Pass `--yes` to skip the confirmation, `--dry-run` to see the version only.

**Installable from GitHub, without any registry.** Both publish workflows also attach the built package to the GitHub Release (the Python wheel and sdist, the TypeScript `keenable-<version>.tgz`), and Go installs from its tag. The attach job is separate from the PyPI / npm job, so a registry problem (for example the npm Trusted Publisher not being registered yet) never blocks the GitHub side; re-run the failed job to finish the registry later. Install commands are in the README.

Without the script: Actions -> **Cut SDK release** -> Run workflow, then open the PR from the release branch yourself and merge it. The workflow doesn't open the PR itself: a PR authored by `github-actions[bot]` can't be approved by the approval bridge, which also runs as that bot.

No tokens: the workflows run on the default `GITHUB_TOKEN` and dispatch the publish workflows themselves (see the workflow header). One-time setup, by an owner of the npm package: register the Trusted Publisher (package `keenable`, repo `keenableai/keenable-sdk`, workflow `publish-typescript.yml`, environment `npm`, allowed action `npm publish`; new configurations default to `npm stage publish` only). The manual steps below remain valid as a fallback.

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
2. Tag `go/v<version>` on the commit that contains that constant. The tag
   prefix is the module directory. Users install with
   `go get github.com/keenableai/keenable-sdk/go@latest`, which resolves to
   the newest `go/v*` tag. A pinned version (`@v<version>`) does not repeat
   the `go/` prefix.
3. The module proxy indexes the tag the first time someone fetches it.

A root `v0.1.0` tag does not version this module. `python-v*` and `ts-v*` do
not publish it either.

## Version sync

The three SDKs keep the same feature surface but version independently. When a
change touches more than one, release each and note it in the same GitHub
Release description.
