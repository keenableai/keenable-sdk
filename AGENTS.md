# Keenable SDK

Official Python, TypeScript and Go SDKs for the Keenable web search API: `python/`, `typescript/` and `go/`, one package per language with the same methods and options in each language's naming style.

## Keep the three SDKs in step

A new option, method, model field or error type goes into all three languages in the same change, with tests in each:

- Go: `cd go && go test ./... && go vet ./...`
- Python: `cd python && python -m pytest -q`
- TypeScript: `cd typescript && npm install && npx vitest run && npx tsc --noEmit`

## Shared conformance cases keep the SDKs alike

`scripts/conformance/cases/*.json` pin down behaviour that must be the same in every SDK: which fetch() URLs are refused, base URL checks, Retry-After parsing, the retry decision, error fields and classes, success-body parsing and argument validation. `scripts/conformance/README.md` states the rules. `node scripts/conformance/sync.ts` writes them to `go/testdata/conformance.json`, `python/tests/fixtures/conformance.json` and `typescript/test/fixtures/conformance.json`, and each SDK's conformance test runs every case. To change one of these behaviours, change the case first, regenerate, and make all three SDKs pass. CI runs `--check` on both sync scripts.

## The error contract comes from the backend's catalog

`scripts/error-contract/error-catalog.json` is a copy of keenable-backend-ts `docs/error-catalog.json` (one entry per error code: type, status, fix, docs_url, ...). The three `error_contract.json` test fixtures are generated from it and must stay identical; each SDK's tests check that. After the backend adds or changes a code, refresh them with Node 22.18+:

    node scripts/error-contract/sync.ts ../keenable-backend-ts/docs/error-catalog.json

`--check` reports a stale fixture without writing. Bodies older servers send live in `scripts/error-contract/before-v1.json`.

## Update the public docs with every user-facing change

The public docs live in [keenable-external-docs](https://github.com/keenableai/keenable-external-docs), and their code examples use these SDKs. When you change the SDK's public behaviour (a new or removed option, a renamed method, a changed signature, a new model field or error type, a version bump), open a docs PR in the same change set and link it in this PR's description. Update there:

- the code samples under `samples/`, then regenerate them with `node scripts/samples-generate.mjs`
- `sdks.mdx`, the product pages under `products/`, and `errors.mdx` for error types
- the install pins in `index.mdx`, `sdks.mdx`, `skill.md` and `llms.txt`
- any note that says the SDK can't do something it now can

Also update this repo's `examples/` and `docs/partners/` when the change affects them.

## The docs and the SDK must match

- **Docs reference the SDKs.** Examples use the official SDKs, with the HTTP API (curl) shown next to them.
- **The SDK covers what the docs describe.** If the docs describe an API feature the SDK can't use, that's an SDK gap: add it, or open an issue here.
- **If it isn't in the public docs, it doesn't exist in the product.** Don't ship an undocumented option or method: document it, or remove it.
