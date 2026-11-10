# Publishing

The Python, TypeScript and Go SDKs release together, on one version.

## Release

1. On a branch, run `node scripts/release/version.ts prepare <x.y.z>` (Node 22.18+).
   It writes the version into `python/pyproject.toml`, `python/keenable/_version.py`,
   `typescript/package.json` and `go/version.go`, and moves each changelog's
   `## Unreleased` under `## <x.y.z>`. It refuses a version that is not above every
   current one, and a release where no SDK has unreleased changes.
2. Update any README line that says a feature ships "in the next release after"
   an older version. Open the PR and merge it once CI is green.
3. `release.yml` runs on the merge. It tags `v<x.y.z>` and `go/v<x.y.z>`, creates
   the GitHub Release from the three changelog sections, and starts:
   - `publish-python.yml`: builds with `uv` and publishes to PyPI.
   - `publish-typescript.yml`: type checks, tests, builds and publishes to npm.
   - the Go smoke test. Go needs no registry; the `go/v<x.y.z>` tag is the release.
4. Each of the three ends with a smoke test. It installs the new version from
   PyPI, npm or the Go module proxy in a clean environment and runs one keyless
   search with `exclude_domains` against production. A red smoke job means the
   published package does not work.

`node scripts/release/version.ts show` prints every file's version, and
`check` fails unless they agree. CI runs `check` from the first `v*` tag on.

A failed publish can be re-run from its workflow page with "Run workflow" on
the `v<x.y.z>` tag. Re-running `release.yml` on a version that is already
tagged does nothing.

## One-time setup

Both registries use Trusted Publishing (OIDC). No tokens are stored.

- PyPI: project `keenable`, Trusted Publisher for repo `keenableai/keenable-sdk`,
  workflow `publish-python.yml`, environment `pypi`.
- npm: package `keenable`, Settings, Trusted publisher, GitHub Actions, repo
  `keenableai/keenable-sdk`, workflow `publish-typescript.yml`, environment `npm`.

## Before the joint releases

Until 0.1.4 (TypeScript), 0.1.3 (Python) and 0.1.1 (Go) the SDKs had their
own versions and tags (`ts-v*`, `python-v*`, `go/v*`). The first joint release
takes all three to one version above those. A GitHub Release tagged
`python-v<version>` still starts `publish-python.yml`.
