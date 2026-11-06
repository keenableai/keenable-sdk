# Keenable SDK

Official Python, TypeScript and Go SDKs for the Keenable web search API: `python/`, `typescript/` and `go/`, one package per language with the same methods and options in each language's naming style.

## Keep the three SDKs in step

A new option, method, model field or error type goes into all three languages in the same change, with tests in each:

- Go: `cd go && go test ./... && go vet ./...`
- Python: `cd python && python -m pytest -q`
- TypeScript: `cd typescript && npm install && npx vitest run && npx tsc --noEmit`

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
