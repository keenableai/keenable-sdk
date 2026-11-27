# One entry point for the checks CI runs, per SDK or all at once.
#   make test       every SDK's tests
#   make lint       every SDK's linters and type checks, plus the examples
#   make sync       the shared fixtures are up to date (Node 22.18+)
#   make smoke      live search and fetch against production, all four SDKs
# Rust targets compile the crate and its dependencies, which is slow and heavy
# on a laptop; run them on a build machine, or leave them to CI.

.PHONY: test lint sync examples smoke \
	test-python test-typescript test-go test-rust \
	lint-python lint-typescript lint-go lint-rust typescript-deps

test: test-python test-typescript test-go test-rust

lint: lint-python lint-typescript lint-go lint-rust examples

test-python:
	cd python && uv run --group dev pytest -q

lint-python:
	cd python && uv run --group dev ruff check . && uv run --group dev ruff format --check .
	cd python && uv run --group dev mypy keenable

# npm 10 crashes resolving vitest's optional peers without --legacy-peer-deps.
typescript-deps:
	cd typescript && npm install --legacy-peer-deps --no-audit --no-fund

test-typescript: typescript-deps
	cd typescript && npx vitest run

lint-typescript: typescript-deps
	cd typescript && npx tsc --noEmit

test-go:
	cd go && go test ./...

lint-go:
	cd go && go vet ./...
	@out=$$(cd go && gofmt -l . && cd .. && gofmt -l scripts/smoke); \
	if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi

test-rust:
	cd rust && cargo test --locked

lint-rust:
	cd rust && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings

sync:
	node scripts/conformance/sync.ts --check
	node scripts/error-contract/sync.ts --check

# Type checks examples/ and scripts/smoke against this checkout's SDKs.
examples: typescript-deps
	cd python && uv run --group dev python -m py_compile ../examples/*/*.py ../scripts/smoke/*.py
	cd python && uv run --group dev mypy --config-file ../examples/mypy.ini ../examples ../scripts/smoke
	cd typescript && npx tsc -p ../examples
	scripts/smoke/run.sh go build

smoke:
	scripts/smoke/run.sh python repo
	scripts/smoke/run.sh typescript repo
	scripts/smoke/run.sh go repo
	scripts/smoke/run.sh rust repo
