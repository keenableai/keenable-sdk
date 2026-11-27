## What and why

<!-- What this changes, and why. One kind of change per pull request. -->

## Checklist

A new option, method, model field or error type goes into all four SDKs, with tests in each. See [CONTRIBUTING.md](https://github.com/keenableai/keenable-sdk/blob/main/CONTRIBUTING.md).

- [ ] Python: code, tests and a `## Unreleased` line in `python/CHANGELOG.md`
- [ ] TypeScript: code, tests and a `## Unreleased` line in `typescript/CHANGELOG.md`
- [ ] Go: code, tests and a `## Unreleased` line in `go/CHANGELOG.md`
- [ ] Rust: code, tests and a `## Unreleased` line in `rust/CHANGELOG.md`
- [ ] Shared behaviour changed in `scripts/conformance/cases/` first, then `node scripts/conformance/sync.ts`
- [ ] Error catalog changes synced with `node scripts/error-contract/sync.ts`
- [ ] A renamed or removed public name keeps a deprecated alias that warns; a breaking change has migration notes in the changelog
- [ ] README, `examples/` and `docs/partners/` updated where the change affects them
- [ ] Docs pull request in [keenable-external-docs](https://github.com/keenableai/keenable-external-docs) for any user-facing change: <!-- link, or "not needed" and why -->
- [ ] No API keys, tokens or `.env` files in the diff

Mark items that don't apply as not needed, with the reason.

## Tests

<!-- The suites you ran, per language, and their result. -->
