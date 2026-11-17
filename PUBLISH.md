# Publishing

Four SDKs ship from this repo, on independent version numbers.

## Automated bump and tag

One command, from any machine with `gh` logged in and Node 22.18+:

```bash
node scripts/release.ts python patch       # or typescript, go, rust; patch, minor, major or X.Y.Z
node scripts/release.ts all 0.1.5          # all four SDKs at one shared version, in one PR
```

It runs the **Cut SDK release** workflow (bumps that SDK's version files below and moves its changelog `Unreleased` entries under the new version, on a `release/<sdk>-vX.Y.Z` branch, and runs the tests), opens the PR as you, waits for the tests and the Qodo approval, squash-merges the commit the tests ran on, and waits for the publish. Merging tags and publishes the SDK: a GitHub Release plus `publish-python.yml` (PyPI) for Python, a GitHub Release plus `publish-typescript.yml` (npm, Trusted Publishing, no OTP) for TypeScript, a `go/v<version>` tag for Go, a GitHub Release plus `publish-rust.yml` (crates.io, Trusted Publishing, no token) for Rust. `all` takes the highest current version as the base for `patch`/`minor`/`major`, and every SDK must end up above its current version. Pass `--yes` to skip the confirmation, `--dry-run` to see the version only.

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

## Rust (`keenable` on crates.io)

Trusted Publishing (OIDC): no crates.io token is stored anywhere.
`publish-rust.yml` runs on a GitHub Release tagged `rust-v<version>`, or when
the release workflow dispatches it on that tag, and publishes from the
`crates-io` environment.

One-time setup, in this order, because crates.io Trusted Publishing works only
for a crate that already exists:

1. Publish 0.1.0 by hand. On crates.io, create a token with only the
   `publish-new` scope and a short expiry, run `cargo publish --locked` in
   `rust/` from a clean checkout of the commit that adds the crate, then revoke
   the token at once. Merging that commit tags `rust-v0.1.0` and runs
   `publish-rust.yml`, which finds 0.1.0 already on crates.io and finishes
   green. If the merge lands first, that run stops with "keenable is not on
   crates.io yet"; publish by hand, then re-run the job.
2. On crates.io, crate `keenable` -> Settings -> Trusted Publishing -> Add:
   repository `keenableai/keenable-sdk`, workflow `publish-rust.yml`,
   environment `crates-io`.
3. In this repo's Settings -> Environments, create `crates-io`: required
   reviewers, admin bypass off, and deployments only from `rust-v*` tags, the
   same as the `pypi` and `npm` environments.
4. Add the second owner: `cargo owner --add <github-login>` in `rust/`.

After that, every release publishes itself: `node scripts/release.ts rust
patch` (or `all`) bumps the version, and merging the release PR tags
`rust-v<version>`, which runs `publish-rust.yml` through OIDC. A re-run of a
version that is already on crates.io does nothing and passes.

To release by hand instead:

1. Bump `version` in `rust/Cargo.toml` and the `keenable` entry in
   `rust/Cargo.lock` (the release workflow does both). `VERSION` and the
   User-Agent read it from `Cargo.toml`, so there is no other copy.
2. Create a GitHub Release tagged `rust-v<version>`. `publish-rust.yml` tests,
   packages and publishes the crate, and attaches the `.crate` file to the
   release.

`Cargo.lock` is resolved to versions that build on the MSRV (1.80, the
`rust-version` in `Cargo.toml`). After changing dependencies, regenerate it
with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile`.

## Version sync

The four SDKs keep the same feature surface but version independently. When a
change touches more than one, release each and note it in the same GitHub
Release description.
