# Contributing to the Keenable SDKs

Thanks for helping. This repo holds four SDKs for the Keenable web search API,
one per language: [`python/`](./python), [`typescript/`](./typescript),
[`go/`](./go) and [`rust/`](./rust). They have the same methods and options,
each in its own language's naming style. Most of the rules below keep them
that way.

Questions before you start? Ask in the [Keenable Discord](https://discord.gg/be3QybVZ2P)
or open an issue. To report a vulnerability, follow [SECURITY.md](./SECURITY.md)
instead of opening an issue.

## Keep the four SDKs in step

A new option, method, model field or error type goes into all four SDKs in the
same pull request, with tests in each. A change that only one language needs
(a packaging fix, an idiom of that language) can stay in that SDK; say why in
the pull request.

Each SDK has its own `CHANGELOG.md`. Add a line under `## Unreleased` in every
SDK your change touches, starting with **Added**, **Changed**, **Fixed**,
**Deprecated** or **Removed**. Mark a breaking change **Changed (breaking)**.

## Shared conformance cases

Some behaviour must be identical in every SDK: which `fetch()` URLs are refused,
base URL checks, `Retry-After` parsing, the retry decision, error fields and
classes, success-body parsing and argument validation. The cases in
[`scripts/conformance/cases/`](./scripts/conformance/cases) pin it down, and
[`scripts/conformance/README.md`](./scripts/conformance/README.md) states the
rules.

To change one of these behaviours:

1. Change or add the case in `scripts/conformance/cases/*.json`.
2. Regenerate the copies each SDK tests against (Node 22.18+):

   ```bash
   node scripts/conformance/sync.ts
   ```

3. Make all four SDKs pass their conformance tests.

CI runs `node scripts/conformance/sync.ts --check` and fails on a stale copy.

## Error contract

[`scripts/error-contract/error-catalog.json`](./scripts/error-contract/error-catalog.json)
is a copy of the API backend's error catalog: one entry per error code, with
its type, HTTP status, fix and docs URL. The four `error_contract.json` test
fixtures are generated from it and must stay identical. After the API adds or
changes an error code, refresh them (Node 22.18+):

```bash
node scripts/error-contract/sync.ts <path to the backend's docs/error-catalog.json>
```

`--check` reports a stale fixture without writing. Error bodies that older
servers send live in `scripts/error-contract/before-v1.json`.

## Run the tests

Run the suite of every SDK you change.

```bash
# Python
cd python && uv run --group dev pytest -q && uv run --group dev ruff check . \
  && uv run --group dev ruff format --check . && uv run --group dev mypy keenable

# TypeScript
cd typescript && npm install --legacy-peer-deps && npx vitest run && npx tsc --noEmit

# Go
cd go && go test ./... && go vet ./... && gofmt -l .

# Rust
cd rust && cargo test --locked && cargo clippy --locked --all-targets -- -D warnings && cargo fmt --check
```

The Rust build is the heaviest: the first `cargo test` compiles the whole
dependency tree and takes several minutes. Run it on a machine with a few cores
to spare, or push and let CI run it. CI runs all four suites on every pull
request (see [`.github/workflows/test.yml`](./.github/workflows/test.yml)).

New scripts are TypeScript, run directly with Node 22.18+, like the existing
ones in [`scripts/`](./scripts).

## Update the public docs

The public docs at [docs.keenable.ai](https://docs.keenable.ai) live in
[keenable-external-docs](https://github.com/keenableai/keenable-external-docs),
and their code samples use these SDKs. When you change public behaviour (a new
or removed option, a renamed method, a changed signature, a new model field or
error type), open a docs pull request there and link the two pull requests both
ways. An option or method that the public docs don't describe must not ship:
document it, or remove it.

Also update this repo's [`examples/`](./examples) and
[`docs/partners/`](./docs/partners) when the change affects them.

## Deprecation policy

The SDKs follow [semver](https://semver.org). Before 1.0, a minor release
(0.x.0) may break code; a patch release never does.

- **Renames and removals go through a deprecation first.** A renamed or
  removed public name (method, option, field, type, error class) keeps a
  deprecated alias that still works and warns when used, for at least one minor
  release, before it is removed. The warning names the replacement. Use each
  language's own mechanism: `DeprecationWarning` in Python, `@deprecated` JSDoc
  and a one-time `console.warn` in TypeScript, a `// Deprecated:` comment in Go,
  `#[deprecated]` in Rust.
- **Every deprecation is in the changelog**, under **Deprecated**, with the
  release that will remove it.
- **Every breaking release has migration notes** in its CHANGELOG entry: what
  changed, and the code to change it to. Mark each such line
  **Changed (breaking)** or **Removed**.

When the API itself removes something, the SDK may have to follow sooner. Say
so in the changelog.

## Releases

Maintainers cut releases with `node scripts/release.ts`; see
[PUBLISH.md](./PUBLISH.md). A release moves each SDK's `## Unreleased` entries
under the new version heading, so leave that heading in place.

## Pull requests

- One kind of change per pull request.
- Fill in the checklist in the pull request template.
- Never put an API key, `.env` file or token in code, tests, fixtures or logs.
